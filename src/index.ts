import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface SearchResult {
    title: string;
    link: string;
    snippet: string;
    position: number;
}

class RateLimiter {
    private requests: Date[] = [];
    private requestsPerMinute: number;

    constructor(requestsPerMinute: number = 30) {
        this.requestsPerMinute = requestsPerMinute;
    }

    async acquire(): Promise<void> {
        const now = new Date();
        // Remove requests older than 1 minute
        this.requests = this.requests.filter(
            req => now.getTime() - req.getTime() < 60000
        );

        if (this.requests.length >= this.requestsPerMinute) {
            // Wait until we can make another request
            const waitTime = 60000 - (now.getTime() - this.requests[0].getTime());
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        this.requests.push(now);
    }
}

class DuckDuckGoSearcher {
    private static readonly BASE_URL = "https://html.duckduckgo.com/html";
    private static readonly HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };

    private rateLimiter = new RateLimiter(30);

    formatResultsForLLM(results: SearchResult[]): string {
        if (results.length === 0) {
            return "No results were found for your search query. This could be due to DuckDuckGo's bot detection or the query returned no matches. Please try rephrasing your search or try again in a few minutes.";
        }

        let output = `Found ${results.length} search results:\n\n`;
        
        for (const result of results) {
            output += `${result.position}. ${result.title}\n`;
            output += `   URL: ${result.link}\n`;
            output += `   Summary: ${result.snippet}\n\n`;
        }

        return output;
    }

    async search(query: string, maxResults: number = 10): Promise<SearchResult[]> {
        try {
            // Apply rate limiting
            await this.rateLimiter.acquire();

            // Create form data for POST request
            const formData = new URLSearchParams({
                q: query,
                b: "",
                kl: ""
            });

            const response = await fetch(DuckDuckGoSearcher.BASE_URL, {
                method: "POST",
                headers: {
                    ...DuckDuckGoSearcher.HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: formData.toString()
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const html = await response.text();
            return this.parseSearchResults(html, maxResults);

        } catch (error) {
            console.error(`Search error: ${error}`);
            return [];
        }
    }

    private parseSearchResults(html: string, maxResults: number): SearchResult[] {
        const results: SearchResult[] = [];
        
        // Simple HTML parsing without external dependencies
        // Look for result blocks using regex patterns
        const resultPattern = /<div[^>]*class="[^"]*result[^"]*"[^>]*>(.*?)<\/div>/gs;
        const titlePattern = /<a[^>]*class="[^"]*result__title[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/s;
        const snippetPattern = /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/div>/s;

        let match;
        let position = 1;

        while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
            const resultHtml = match[1];
            
            const titleMatch = titlePattern.exec(resultHtml);
            if (!titleMatch) continue;

            let link = titleMatch[1];
            const titleHtml = titleMatch[2];
            
            // Skip ad results
            if (link.includes("y.js")) continue;

            // Clean up DuckDuckGo redirect URLs
            if (link.startsWith("//duckduckgo.com/l/?uddg=")) {
                try {
                    link = decodeURIComponent(link.split("uddg=")[1].split("&")[0]);
                } catch (e) {
                    continue;
                }
            }

            // Extract title text (remove HTML tags)
            const title = this.stripHtmlTags(titleHtml).trim();
            if (!title) continue;

            // Extract snippet
            const snippetMatch = snippetPattern.exec(resultHtml);
            const snippet = snippetMatch ? this.stripHtmlTags(snippetMatch[1]).trim() : "";

            results.push({
                title,
                link,
                snippet,
                position: position++
            });
        }

        return results;
    }

    private stripHtmlTags(html: string): string {
        return html.replace(/<[^>]*>/g, "").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ");
    }
}

class WebContentFetcher {
    private rateLimiter = new RateLimiter(20);

    async fetchAndParse(url: string): Promise<string> {
        try {
            await this.rateLimiter.acquire();

            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                },
                redirect: "follow"
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const html = await response.text();
            return this.parseContent(html);

        } catch (error) {
            if (error instanceof TypeError && error.message.includes("fetch")) {
                return "Error: The request timed out while trying to fetch the webpage.";
            }
            return `Error: Could not access the webpage (${error instanceof Error ? error.message : String(error)})`;
        }
    }

    private parseContent(html: string): string {
        // Remove script, style, nav, header, footer elements
        let cleanHtml = html.replace(/<(script|style|nav|header|footer)[^>]*>.*?<\/\1>/gis, "");
        
        // Remove all HTML tags
        let text = cleanHtml.replace(/<[^>]*>/g, " ");
        
        // Decode HTML entities
        text = text.replace(/&nbsp;/g, " ")
                  .replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'");

        // Clean up whitespace
        const lines = text.split("\n").map(line => line.trim()).filter(line => line);
        text = lines.join(" ");
        
        // Remove extra whitespace
        text = text.replace(/\s+/g, " ").trim();

        // Truncate if too long
        if (text.length > 8000) {
            text = text.substring(0, 8000) + "... [content truncated]";
        }

        return text || "No readable content found on this webpage.";
    }
}

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "DuckDuckGo MCP Server",
        version: "1.0.0",
    });

    private searcher = new DuckDuckGoSearcher();
    private fetcher = new WebContentFetcher();

    async init() {
        // Real Search Tool
        this.server.tool(
            "search",
            {
                tool_name: "search",
                description: "Performs a real search query on DuckDuckGo and returns actual results.",
                parameters_zod_schema: {
                    query: z.string().describe("The search query string"),
                    max_results: z
                        .number()
                        .int()
                        .min(1)
                        .max(20)
                        .default(10)
                        .describe("Maximum number of results to return (default: 10, max: 20)"),
                },
                logic_description: "Searches DuckDuckGo using their HTML interface and parses real search results.",
            },
            async ({ query, max_results }) => {
                try {
                    const results = await this.searcher.search(query, max_results);
                    const formattedResults = this.searcher.formatResultsForLLM(results);
                    
                    return {
                        content: [{
                            type: "text",
                            text: formattedResults
                        }]
                    };
                } catch (error) {
                    return {
                        content: [{
                            type: "text",
                            text: `An error occurred while searching: ${error instanceof Error ? error.message : String(error)}`,
                            isError: true
                        }]
                    };
                }
            }
        );

        // Real Content Fetching Tool
        this.server.tool(
            "fetch_content",
            {
                tool_name: "fetch_content",
                description: "Fetches and parses real content from a specified webpage URL.",
                parameters_zod_schema: {
                    url: z.string().url().describe("The webpage URL to fetch content from"),
                },
                logic_description: "Fetches the actual webpage, removes navigation/scripts/styles, and returns cleaned text content.",
            },
            async ({ url }) => {
                try {
                    const content = await this.fetcher.fetchAndParse(url);
                    
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
                            text: `Error fetching content from ${url}: ${error instanceof Error ? error.message : String(error)}`,
                            isError: true
                        }]
                    };
                }
            }
        );
    }
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        // HTTP Endpoint Exposure:
        // /sse: For Server-Sent Events (SSE) communication with the MCP server.
        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
        }

        // /mcp: For standard MCP communication.
        if (url.pathname === "/mcp") {
            return MyMCP.serve("/mcp").fetch(request, env, ctx);
        }

        // Default response for unhandled paths
        return new Response("Not found", { status: 404 });
    },
};