import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

class MyMCP {
  private server: McpServer;
  private rateLimits = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    this.server = new McpServer({
      name: "duckduckgo-mcp-server",
      version: "0.1.1",
    });

    this.init();
  }

  private async checkRateLimit(key: string, limit: number, window: number): Promise<boolean> {
    const now = Date.now();
    const limitKey = `${key}:${Math.floor(now / (window * 1000))}`;
    
    const current = this.rateLimits.get(limitKey) || { count: 0, resetAt: now + (window * 1000) };
    
    if (current.count >= limit) {
      return false;
    }
    
    current.count++;
    this.rateLimits.set(limitKey, current);
    
    // Clean up old entries
    for (const [k, v] of this.rateLimits.entries()) {
      if (v.resetAt < now) {
        this.rateLimits.delete(k);
      }
    }
    
    return true;
  }

  private cleanDuckDuckGoUrl(url: string): string {
    if (url.startsWith("//duckduckgo.com/l/?uddg=")) {
      return decodeURIComponent(url.split("uddg=")[1].split("&")[0]);
    }
    return url;
  }

  private extractTextFromHtml(html: string): string {
    // Basic HTML tag stripping - could be enhanced with proper parser
    let text = html;
    
    // Remove script and style tags
    text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    
    // Remove nav, header, footer elements
    text = text.replace(/<(nav|header|footer)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '');
    
    // Remove all HTML tags
    text = text.replace(/<[^>]*>/g, ' ');
    
    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    return text;
  }

  private async searchDuckDuckGo(query: string, maxResults: number): Promise<Array<{
    title: string;
    link: string;
    snippet: string;
    position: number;
  }>> {
    const searchUrl = "https://html.duckduckgo.com/html";
    const formData = new URLSearchParams();
    formData.append("q", query);
    formData.append("b", "");
    formData.append("kl", "");

    const response = await fetch(searchUrl, {
      method: "POST",
      body: formData,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    
    // Basic HTML parsing with regex (for Cloudflare Workers compatibility)
    const results = [];
    const resultRegex = /<div class="result[^"]*"[^>]*>(.*?)<\/div>/gs;
    let match;
    let position = 1;

    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const resultHtml = match[1];
      
      // Extract title
      const titleMatch = resultHtml.match(/<a class="result__a"[^>]*>(.*?)<\/a>/);
      if (!titleMatch) continue;
      
      const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      
      // Extract link
      const linkMatch = resultHtml.match(/<a class="result__a"[^>]*href="([^"]*)"/);
      if (!linkMatch) continue;
      
      let link = linkMatch[1];
      link = this.cleanDuckDuckGoUrl(link);
      
      // Skip ads
      if (link.includes("y.js")) continue;
      
      // Extract snippet
      const snippetMatch = resultHtml.match(/<a class="result__snippet"[^>]*>(.*?)<\/a>/);
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : "";
      
      results.push({
        title,
        link,
        snippet,
        position: position++,
      });
    }

    return results;
  }

  private async fetchWebContent(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    let text = this.extractTextFromHtml(html);
    
    // Truncate if too long
    if (text.length > 8000) {
      text = text.substring(0, 8000) + "... [content truncated]";
    }
    
    return text;
  }

  private init() {
    // Existing calculator tools
    this.server.tool(
      "add",
      { a: z.number(), b: z.number() },
      ({ a, b }) => ({
        content: [{ type: "text", text: String(a + b) }],
      })
    );

    this.server.tool(
      "subtract",
      { a: z.number(), b: z.number() },
      ({ a, b }) => ({
        content: [{ type: "text", text: String(a - b) }],
      })
    );

    this.server.tool(
      "multiply",
      { a: z.number(), b: z.number() },
      ({ a, b }) => ({
        content: [{ type: "text", text: String(a * b) }],
      })
    );

    this.server.tool(
      "divide",
      { a: z.number(), b: z.number() },
      ({ a, b }) => ({
        content: [{ type: "text", text: String(a / b) }],
      })
    );

    // New DuckDuckGo search tool
    this.server.tool(
      "search",
      { 
        query: z.string().describe("The search query string"),
        max_results: z.number().min(1).max(20).default(10).describe("Maximum number of results to return")
      },
      async ({ query, max_results }) => {
        try {
          // Check rate limit: 30 requests per minute
          const canProceed = await this.checkRateLimit("search", 30, 60);
          if (!canProceed) {
            return {
              content: [{ 
                type: "text", 
                text: "Rate limit exceeded. Please wait a minute before making more search requests." 
              }]
            };
          }

          const results = await this.searchDuckDuckGo(query, max_results);
          
          if (results.length === 0) {
            return {
              content: [{ 
                type: "text", 
                text: "No results were found for your search query. This could be due to DuckDuckGo's bot detection or the query returned no matches. Please try rephrasing your search or try again in a few minutes." 
              }]
            };
          }

          let output = `Found ${results.length} search results:\n\n`;
          
          for (const result of results) {
            output += `${result.position}. ${result.title}\n`;
            output += `   URL: ${result.link}\n`;
            output += `   Summary: ${result.snippet}\n\n`;
          }

          return {
            content: [{ type: "text", text: output }]
          };
        } catch (error) {
          return {
            content: [{ 
              type: "text", 
              text: `An error occurred while searching: ${error.message}` 
            }]
          };
        }
      }
    );

    // New content fetching tool
    this.server.tool(
      "fetch_content",
      { 
        url: z.string().url().describe("The webpage URL to fetch content from")
      },
      async ({ url }) => {
        try {
          // Check rate limit: 20 requests per minute
          const canProceed = await this.checkRateLimit("fetch", 20, 60);
          if (!canProceed) {
            return {
              content: [{ 
                type: "text", 
                text: "Rate limit exceeded. Please wait a minute before fetching more content." 
              }]
            };
          }

          const content = await this.fetchWebContent(url);
          
          return {
            content: [{ 
              type: "text", 
              text: content 
            }]
          };
        } catch (error) {
          return {
            content: [{ 
              type: "text", 
              text: `Error fetching content from ${url}: ${error.message}` 
            }]
          };
        }
      }
    );
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  // Static methods for Cloudflare Workers
  static serve(path: string) {
    return new MyMCP().server.serveHttp(path);
  }

  static serveSSE(path: string) {
    return new MyMCP().server.serveSSE(path);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

// For local development (stdio mode)
if (typeof process !== "undefined" && process.argv.includes("--stdio")) {
  const mcp = new MyMCP();
  mcp.run().catch(console.error);
}
