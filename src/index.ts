import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
    server = new McpServer({
        name: "Authless DuckDuckGo MCP Server", // Updated server name
        version: "1.0.0",
    });

    async init() {
        // New Search Tool
        this.server.tool(
            {
                tool_name: "search",
                description: "Simulates a search query and returns mock results.",
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
                logic_description: "Simulate search results based on the DuckDuckGo Searcher's format.",
            },
            async ({ query, max_results }) => {
                try {
                    // Simulate search results
                    const mockResults = [
                        {
                            title: "Example Result 1: Cloudflare Workers",
                            link: "https://www.cloudflare.com/workers/",
                            snippet: "Cloudflare Workers provides a serverless execution environment...",
                        },
                        {
                            title: "Example Result 2: Model Context Protocol",
                            link: "https://modelcontextprotocol.io/",
                            snippet: "The Model Context Protocol (MCP) is an open specification...",
                        },
                        {
                            title: "Example Result 3: Zod Documentation",
                            link: "https://zod.dev/",
                            snippet: "Zod is a TypeScript-first schema declaration and validation library...",
                        },
                        {
                            title: "Example Result 4: GitHub Actions",
                            link: "https://docs.github.com/en/actions",
                            snippet: "Automate, customize, and execute your software development workflows...",
                        },
                    ];

                    // Filter and truncate results based on max_results
                    const resultsToDisplay = mockResults.slice(0, max_results);

                    if (resultsToDisplay.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No results were found for your search query: "${query}". Please try rephrasing your search or try again.`,
                                },
                            ],
                        };
                    }

                    let formattedResults = `Found ${resultsToDisplay.length} search results for "${query}":\n\n`;
                    resultsToDisplay.forEach((res, index) => {
                        formattedResults += `${index + 1}. ${res.title}\n`;
                        formattedResults += `   URL: ${res.link}\n`;
                        formattedResults += `   Summary: ${res.snippet}\n\n`;
                    });

                    return { content: [{ type: "text", text: formattedResults }] };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `An error occurred while searching: ${error instanceof Error ? error.message : String(error)}`,
                                isError: true,
                            },
                        ],
                    };
                }
            },
        );

        // New Content Fetching Tool
        this.server.tool(
            {
                tool_name: "fetch_content",
                description: "Fetches content from a specified webpage URL.",
                parameters_zod_schema: {
                    url: z.string().url().describe("The webpage URL to fetch content from"),
                },
                logic_description: "Simulate fetching and parsing content from a URL.",
            },
            async ({ url }) => {
                try {
                    // Simulate fetching and parsing content
                    let mockContent = `This is simulated content fetched from ${url}. It represents the cleaned and formatted text of a webpage...`;

                    // Simulate an error for specific URLs
                    if (url.includes("error") || url.includes("fail")) {
                        throw new Error("Simulated network or parsing error during content fetch.");
                    }

                    // Simulate truncation for longer content
                    const maxLength = 8000;
                    if (mockContent.length > maxLength) {
                        mockContent = mockContent.substring(0, maxLength) + "... [content truncated]";
                    }

                    return { content: [{ type: "text", text: mockContent }] };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error fetching content from ${url}: ${error instanceof Error ? error.message : String(error)}`,
                                isError: true,
                            },
                        ],
                    };
                }
            },
        );
    }
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        // HTTP Endpoint Exposure:
        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
        }

        if (url.pathname === "/mcp") {
            return MyMCP.serve("/mcp").fetch(request, env, ctx);
        }

        // Default response for unhandled paths
        return new Response("Not found", { status: 404 });
    },
};
