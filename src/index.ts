import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as cheerio from "cheerio";

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

            console.log(`Searching DuckDuckGo for: ${query}`);

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
            const results = this.parseSearchResults(html, maxResults);
            
            console.log(`Successfully found ${results.length} results`);
            return results;

        } catch (error) {
            if (error instanceof TypeError && error.message.includes("fetch")) {
                console.error("Search request timed out");
                return [];
            }
            console.error(`Search error: ${error}`);
            return [];
        }
    }

    private parseSearchResults(html: string, maxResults: number): SearchResult[] {
        const results: SearchResult[] = [];
        
        try {
            // Use cheerio for robust HTML parsing (like BeautifulSoup)
            const $ = cheerio.load(html);
            
            // Find all result elements using CSS selectors (matching server.py approach)
            $('.result').each((index, element) => {
                if (results.length >= maxResults) return false; // Break the loop
                
                const $result = $(element);
                
                // Find title and link using CSS selectors
                const $titleLink = $result.find('.result__title a').first();
                if ($titleLink.length === 0) return; // Continue to next result
                
                const title = $titleLink.text().trim();
                let link = $titleLink.attr('href') || '';
                
                if (!title || !link) return; // Continue to next result
                
                // Skip ad results
                if (link.includes('y.js')) return;
                
                // Clean up DuckDuckGo redirect URLs (matching server.py logic)
                if (link.startsWith('//duckduckgo.com/l/?uddg=')) {
                    try {
                        const encodedUrl = link.split('uddg=')[1].split('&')[0];
                        link = decodeURIComponent(encodedUrl);
                    } catch (e) {
                        return; // Skip this result if URL decoding fails
                    }
                }
                
                // Find snippet using CSS selector
                const $snippet = $result.find('.result__snippet').first();
                const snippet = $snippet.text().trim();
                
                results.push({
                    title,
                    link,
                    snippet,
                    position: results.length + 1
                });
            });
            
        } catch (error) {
            console.error(`Error parsing search results: ${error}`);
        }
        
        return results;
    }
}

class WebContentFetcher {
    private rateLimiter = new RateLimiter(20);

    async fetchAndParse(url: string): Promise<string> {
        try {
            await this.rateLimiter.acquire();

            console.log(`Fetching content from: ${url}`);

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
            const content = this.parseContent(html);
            
            console.log(`Successfully fetched and parsed content (${content.length} characters)`);
            return content;

        } catch (error) {
            if (error instanceof TypeError && error.message.includes("fetch")) {
                console.error(`Request timed out for URL: ${url}`);
                return "Error: The request timed out while trying to fetch the webpage.";
            }
            console.error(`Error fetching content from ${url}: ${error}`);
            return `Error: Could not access the webpage (${error instanceof Error ? error.message : String(error)})`;
        }
    }

    private parseContent(html: string): string {
        try {
            // Use cheerio for robust HTML parsing (matching server.py with BeautifulSoup)
            const $ = cheerio.load(html);
            
            // Remove script, style, nav, header, footer elements (matching server.py)
            $('script, style, nav, header, footer').remove();
            
            // Get the text content (equivalent to BeautifulSoup's get_text())
            let text = $.text();
            
            // Clean up the text (matching server.py logic)
            const lines = text.split('\n').map(line => line.trim()).filter(line => line);
            const chunks = lines.flatMap(line => 
                line.split('  ').map(phrase => phrase.trim()).filter(phrase => phrase)
            );
            text = chunks.join(' ');
            
            // Remove extra whitespace (matching server.py regex)
            text = text.replace(/\s+/g, ' ').trim();
            
            // Truncate if too long (matching server.py)
            if (text.length > 8000) {
                text = text.substring(0, 8000) + '... [content truncated]';
            }
            
            return text || "No readable content found on this webpage.";
            
        } catch (error) {
            console.error(`Error parsing HTML content: ${error}`);
            return "Error: Failed to parse webpage content.";
        }
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
                description: "Performs a real search query on DuckDuckGo and returns actual results.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query string"
                        },
                        max_results: {
                            type: "number",
                            description: "Maximum number of results to return (default: 10, max: 20)",
                            minimum: 1,
                            maximum: 20,
                            default: 10
                        }
                    },
                    required: ["query"]
                }
            },
            async (args) => {
                const { query, max_results = 10 } = args;
                
                // Handle both direct args and nested args structure
                const actualQuery = args.query || args.arguments?.query || (typeof args === 'string' ? args : '');
                const actualMaxResults = args.max_results || args.arguments?.max_results || max_results;
                
                if (!actualQuery || typeof actualQuery !== 'string' || actualQuery.trim() === '') {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Query parameter is required and must be a non-empty string. Received: ${JSON.stringify(args)}`,
                            isError: true
                        }]
                    };
                }
                
                try {
                    console.log(`Processing search request with query: "${actualQuery}" and max_results: ${actualMaxResults}`);
                    const results = await this.searcher.search(actualQuery, actualMaxResults);
                    const formattedResults = this.searcher.formatResultsForLLM(results);
                    
                    return {
                        content: [{
                            type: "text",
                            text: formattedResults
                        }]
                    };
                } catch (error) {
                    console.error(`Search tool error: ${error}`);
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
                description: "Fetches and parses real content from a specified webpage URL using robust HTML parsing.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: {
                            type: "string",
                            description: "The webpage URL to fetch content from",
                            format: "uri"
                        }
                    },
                    required: ["url"]
                }
            },
            async (args) => {
                // Handle both direct args and nested args structure
                const actualUrl = args.url || args.arguments?.url || '';
                
                if (!actualUrl || typeof actualUrl !== 'string' || actualUrl.trim() === '') {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: URL parameter is required and must be a non-empty string. Received: ${JSON.stringify(args)}`,
                            isError: true
                        }]
                    };
                }
                
                try {
                    console.log(`Processing fetch content request for URL: "${actualUrl}"`);
                    const content = await this.fetcher.fetchAndParse(actualUrl);
                    
                    return {
                        content: [{
                            type: "text",
                            text: content
                        }]
                    };
                } catch (error) {
                    console.error(`Fetch content tool error: ${error}`);
                    return {
                        content: [{
                            type: "text",
                            text: `Error fetching content from ${actualUrl}: ${error instanceof Error ? error.message : String(error)}`,
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