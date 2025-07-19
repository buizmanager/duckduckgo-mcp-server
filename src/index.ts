import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "Authless Calculator and Search", // Updated name for the server
        version: "1.0.0",
    });

    // Rate limiters for search and content fetching.
    // These instances will persist within the Durable Object.
    private searchRateLimiter: RateLimiter;
    private contentRateLimiter: RateLimiter;

    constructor(state: DurableObjectState, env: Env) {
        super(state, env); // Pass Durable Object state and environment to the base McpAgent constructor

        this.searchRateLimiter = new RateLimiter(30); // 30 requests per minute for search
        this.contentRateLimiter = new RateLimiter(20); // 20 requests per minute for content fetching

        // Load rate limiter state from Durable Object storage when the DO is constructed.
        // This ensures the rate limits persist across DO restarts.
        this.state.storage.get<number[]>("searchRequests").then(savedRequests => {
            if (savedRequests) {
                this.searchRateLimiter.setRequests(savedRequests);
            }
        });
        this.state.storage.get<number[]>("contentRequests").then(savedRequests => {
            if (savedRequests) {
                this.contentRateLimiter.setRequests(savedRequests);
            }
        });
    }

    // The `init()` method is called by the `McpAgent` base class after its own setup.
    // This is where you define and register your custom MCP tools.
    async init() {
        // Existing "add" tool
        this.server.tool(
            "add",
            { a: z.number(), b: z.number() },
            async ({ a, b }) => ({
                content: [{ type: "text", text: String(a + b) }],
            })
        );

        // Existing "calculate" tool
        this.server.tool(
            "calculate",
            {
                operation: z.enum(["add", "subtract", "multiply", "divide"]),
                a: z.number(),
                b: z.number(),
            },
            async ({ operation, a, b }) => {
                let result: number;
                switch (operation) {
                    case "add":
                        result = a + b;
                        break;
                    case "subtract":
                        result = a - b;
                        break;
                    case "multiply":
                        result = a * b;
                        break;
                    case "divide":
                        if (b === 0)
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "Error: Cannot divide by zero",
                                    },
                                ],
                            };
                        result = a / b;
                        break;
                    default:
                        return { content: [{ type: "text", text: "Error: Invalid operation" }] };
                }
                return { content: [{ type: "text", text: String(result) }] };
            }
        );

        // New "search" tool: Performs web search using DuckDuckGo.
        this.server.tool(
            "search",
            {
                query: z.string().describe("The search query string"),
                max_results: z.number().int().min(1).max(20).optional().default(10).describe("Maximum number of results to return (default: 10, max: 20)"),
            },
            async ({ query, max_results }) => {
                try {
                    const results = await this.performDuckDuckGoSearch(query, max_results);
                    // Save the updated rate limiter state back to Durable Object storage
                    await this.state.storage.put("searchRequests", this.searchRateLimiter.getRequests());
                    return { content: [{ type: "text", text: this.formatSearchResultsForLLM(results) }] };
                } catch (e: any) {
                    console.error(`Error in search tool: ${e.message}`);
                    return { content: [{ type: "text", text: `An error occurred while searching: ${e.message}` }] };
                }
            }
        );

        // New "fetch_content" tool: Fetches and parses content from a given URL.
        this.server.tool(
            "fetch_content",
            {
                url: z.string().url().describe("The webpage URL to fetch content from"),
            },
            async ({ url }) => {
                try {
                    const content = await this.performWebContentFetch(url);
                    // Save the updated rate limiter state back to Durable Object storage
                    await this.state.storage.put("contentRequests", this.contentRateLimiter.getRequests());
                    return { content: [{ type: "text", text: content }] };
                } catch (e: any) {
                    console.error(`Error in fetch_content tool: ${e.message}`);
                    return { content: [{ type: "text", text: `An error occurred while fetching content: ${e.message}` }] };
                }
            }
        );
    }

    // --- DuckDuckGo Searcher Logic (Adapted from Python) ---

    private readonly DDG_BASE_URL = "https://html.duckduckgo.com/html";
    private readonly DDG_HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };

    /**
     * Performs a web search on DuckDuckGo and returns formatted results.
     * Replicates the core logic of `DuckDuckGoSearcher.search` from the Python codebase.
     */
    private async performDuckDuckGoSearch(query: string, max_results: number): Promise<SearchResult[]> {
        console.log(`Searching DuckDuckGo for: "${query}"`);
        await this.searchRateLimiter.acquire(); // Apply rate limiting

        const formData = new URLSearchParams();
        formData.append("q", query);
        formData.append("b", "");
        formData.append("kl", "");

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout for the request

            const response = await fetch(this.DDG_BASE_URL, {
                method: "POST",
                headers: {
                    ...this.DDG_HEADERS,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: formData.toString(),
                signal: controller.signal,
            });

            clearTimeout(timeoutId); // Clear timeout if request completes before timeout

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const html = await response.text();
            const results: SearchResult[] = [];
            let currentTitle: string = "";
            let currentLink: string = "";
            let currentSnippet: string = "";
            let inTitleLink = false;
            let inSnippet = false;
            let positionCounter = 0;

            // Use HTMLRewriter to parse the HTML and extract search results
            const rewriter = new HTMLRewriter()
                .on(".result", { // Start of a new search result block
                    element: () => {
                        positionCounter++;
                        // Reset current result data for the new block
                        currentTitle = "";
                        currentLink = "";
                        currentSnippet = "";
                    },
                    end: () => { // End of a search result block
                        // Process and add the collected result if valid and within max_results limit
                        if (currentLink?.startsWith("//duckduckgo.com/l/?uddg=")) {
                            const urlParts = currentLink.split("uddg=");
                            if (urlParts.length > 1) {
                                currentLink = decodeURIComponent(urlParts[1].split("&")[0]);
                            }
                        }
                        // Skip ad results (y.js) and ensure all parts are present
                        if (currentLink && !currentLink.includes("y.js") && currentTitle && currentSnippet && results.length < max_results) {
                            results.push({
                                title: currentTitle.trim(),
                                link: currentLink,
                                snippet: currentSnippet.trim(),
                                position: positionCounter,
                            });
                        }
                    }
                })
                .on(".result__title a", { // Link within the title
                    element: (element) => {
                        inTitleLink = true;
                        currentLink = element.getAttribute("href") || "";
                    },
                    text: (text) => {
                        if (inTitleLink) {
                            currentTitle += text.text;
                        }
                    },
                    end: () => {
                        inTitleLink = false;
                    }
                })
                .on(".result__snippet", { // Snippet text
                    element: () => {
                        inSnippet = true;
                    },
                    text: (text) => {
                        if (inSnippet) {
                            currentSnippet += text.text;
                        }
                    },
                    end: () => {
                        inSnippet = false;
                    }
                });

            // Transform the HTML string using HTMLRewriter.
            // Calling .arrayBuffer() ensures the entire stream is processed.
            await rewriter.transform(new Response(html)).arrayBuffer();

            console.log(`Successfully found ${results.length} results for query: "${query}"`);
            return results;

        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error("Search request timed out.");
            }
            throw new Error(`Error during search: ${error.message}`);
        }
    }

    /**
     * Formats search results into a human-readable string optimized for LLM consumption.
     * Replicates `format_results_for_llm` from the Python codebase.
     */
    private formatSearchResultsForLLM(results: SearchResult[]): string {
        if (!results || results.length === 0) {
            return "No results were found for your search query. This could be due to DuckDuckGo's bot detection or the query returned no matches. Please try rephrasing your search or try again in a few minutes.";
        }

        let output = [`Found ${results.length} search results:\n`];

        results.forEach((result) => {
            output.push(`${result.position}. ${result.title}`);
            output.push(`   URL: ${result.link}`);
            output.push(`   Summary: ${result.snippet}`);
            output.push(""); // Empty line between results for readability
        });

        return output.join("\n");
    }

    // --- Web Content Fetcher Logic (Adapted from Python) ---

    /**
     * Fetches and parses content from a webpage URL.
     * Replicates `WebContentFetcher.fetch_and_parse` from the Python codebase.
     */
    private async performWebContentFetch(url: string): Promise<string> {
        console.log(`Fetching content from: "${url}"`);
        await this.contentRateLimiter.acquire(); // Apply rate limiting

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout

            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                },
                redirect: "follow", // Automatically follow redirects
                signal: controller.signal,
            });

            clearTimeout(timeoutId); // Clear timeout if request completes before timeout

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const html = await response.text();
            let extractedText = "";

            // Use HTMLRewriter to remove unwanted elements and extract all visible text
            const rewriter = new HTMLRewriter()
                .on("script", { element: (element) => element.remove() })
                .on("style", { element: (element) => element.remove() })
                .on("nav", { element: (element) => element.remove() })
                .on("header", { element: (element) => element.remove() })
                .on("footer", { element: (element) => element.remove() })
                .on("*", { // Capture text from all other elements
                    text: (text) => {
                        extractedText += text.text;
                    }
                });

            // Process the entire HTML stream
            await rewriter.transform(new Response(html)).arrayBuffer();

            // Clean up the extracted text: remove extra whitespace, newlines, and trim
            let cleanedText = extractedText
                .split(/\r?\n/) // Split by newlines (handles both \n and \r\n)
                .map(line => line.trim()) // Trim whitespace from each line
                .filter(line => line.length > 0) // Filter out empty lines
                .join(" "); // Join non-empty lines with a single space

            // Replace multiple spaces with a single space and trim the final string
            cleanedText = cleanedText.replace(/\s+/g, " ").trim();

            // Truncate if the content is too long
            const MAX_CONTENT_LENGTH = 8000;
            if (cleanedText.length > MAX_CONTENT_LENGTH) {
                cleanedText = cleanedText.substring(0, MAX_CONTENT_LENGTH) + "... [content truncated]";
            }

            console.log(`Successfully fetched and parsed content (${cleanedText.length} characters) from: "${url}"`);
            return cleanedText;

        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error("The request timed out while trying to fetch the webpage.");
            }
            throw new Error(`Error: Could not access the webpage (${error.message})`);
        }
    }
}

// --- Helper Classes and Interfaces ---

/**
 * Interface representing a single search result.
 */
interface SearchResult {
    title: string;
    link: string;
    snippet: string;
    position: number;
}

/**
 * Implements a simple rate limiting mechanism based on requests per minute.
 * Stores request timestamps and waits if the limit is exceeded.
 */
class RateLimiter {
    private requests: number[] = []; // Array of timestamps (milliseconds) for past requests
    private requestsPerMinute: number;

    constructor(requestsPerMinute: number) {
        this.requestsPerMinute = requestsPerMinute;
    }

    /**
     * Sets the internal requests array. Used for loading state from Durable Object storage.
     */
    setRequests(requests: number[]) {
        this.requests = requests;
    }

    /**
     * Returns the current requests array. Used for saving state to Durable Object storage.
     */
    getRequests(): number[] {
        return this.requests;
    }

    /**
     * Acquires a slot for a new request. If the rate limit is hit, it waits.
     */
    async acquire(): Promise<void> {
        const now = Date.now(); // Current timestamp in milliseconds

        // Filter out requests older than 1 minute (60,000 milliseconds)
        this.requests = this.requests.filter(reqTime => now - reqTime < 60000);

        if (this.requests.length >= this.requestsPerMinute) {
            // If the limit is reached, calculate how long to wait until the oldest request expires
            const oldestRequestTime = this.requests[0];
            const timeElapsedSinceOldest = now - oldestRequestTime;
            const timeToWait = 60000 - timeElapsedSinceOldest; // Time in milliseconds

            if (timeToWait > 0) {
                console.log(`Rate limit hit. Waiting for ${timeToWait / 1000} seconds.`);
                await new Promise(resolve => setTimeout(resolve, timeToWait));
                // After waiting, re-filter the requests array as time has passed
                const newNow = Date.now();
                this.requests = this.requests.filter(reqTime => newNow - reqTime < 60000);
            }
        }
        // Add the current request timestamp
        this.requests.push(Date.now());
    }
}

// Main fetch handler for the Cloudflare Worker.
// This handler is responsible for routing incoming requests to the `MyMCP` Durable Object.
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Get a Durable Object ID. Using a fixed name ("MyMCPInstance") to ensure a singleton instance.
        // This ensures all MCP requests are routed to the same Durable Object.
        const durableObjectId = env.MCP_OBJECT.idFromName("MyMCPInstance");
        // Get the Durable Object stub, which allows communication with the DO instance.
        const durableObjectStub = env.MCP_OBJECT.get(durableObjectId);

        // The McpAgent base class (extended by MyMCP) handles the /sse and /mcp paths
        // internally when its fetch method is called.
        // By forwarding requests for these specific paths to the Durable Object,
        // we leverage the McpAgent's built-in routing.
        if (url.pathname === "/sse" || url.pathname === "/sse/message" || url.pathname === "/mcp") {
            return durableObjectStub.fetch(request);
        }

        // For any other path, return a 404 Not Found response.
        return new Response("Not found", { status: 404 });
    },
};
