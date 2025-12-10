import type { OutgoingHttpHeaders } from "node:http";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { allowInsecureTls, customFetchOptions } from "./common";

interface CustomResponse {
	ok: boolean;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	text: () => Promise<string>;
	json: () => Promise<unknown>;
	arrayBuffer: () => Promise<ArrayBuffer>;
}

interface NodeError extends Error {
	code?: string;
}

interface RetryOptions {
	maxRetries?: number;
	retryDelay?: number;
	timeout?: number;
	followRedirects?: boolean;
	maxRedirects?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<
	Omit<RetryOptions, "followRedirects" | "maxRedirects">
> = {
	maxRetries: customFetchOptions.maxRetries,
	retryDelay: customFetchOptions.retryDelay,
	timeout: customFetchOptions.timeout,
};

const DEFAULT_FOLLOW_REDIRECTS = true;
const DEFAULT_MAX_REDIRECTS = 5;

let hasShownInsecureTlsWarning = false;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeRequest(
	url: string,
	options: RequestInit & RetryOptions = {},
	retryCount = 0,
	redirectCount = 0,
): Promise<CustomResponse> {
	const {
		maxRetries = DEFAULT_RETRY_OPTIONS.maxRetries,
		retryDelay = DEFAULT_RETRY_OPTIONS.retryDelay,
		timeout = DEFAULT_RETRY_OPTIONS.timeout,
		followRedirects = DEFAULT_FOLLOW_REDIRECTS,
		maxRedirects = DEFAULT_MAX_REDIRECTS,
		...fetchOptions
	} = options;

	const mergedOptions = {
		...customFetchOptions,
		...fetchOptions,
	};

	const parsedUrl = new URL(url);
	const protocol = parsedUrl.protocol === "https:" ? https : http;

	// Preserve original header case for Cloudflare Access.
	const headers: OutgoingHttpHeaders = {};
	if (mergedOptions.headers) {
		for (const [key, value] of Object.entries(
			mergedOptions.headers as Record<string, unknown>,
		)) {
			if (key.toLowerCase().startsWith("cf-access-")) {
				headers[key] = value as string;
			} else {
				headers[key.toLowerCase()] = value as string;
			}
		}
	}

	return new Promise((resolve, reject) => {
		const isHttps = parsedUrl.protocol === "https:";

		if (isHttps && allowInsecureTls && !hasShownInsecureTlsWarning) {
			hasShownInsecureTlsWarning = true;
			console.warn(
				"ALLOW_INSECURE_TLS=true: TLS certificate verification is disabled for HTTPS requests.",
			);
		}

		const req = protocol.request(
			url,
			{
				method: mergedOptions.method || "GET",
				headers,
				timeout,
				...(isHttps
					? {
							rejectUnauthorized: !allowInsecureTls,
							minVersion: "TLSv1.2" as const,
							maxVersion: "TLSv1.3" as const,
							ciphers: "HIGH:!aNULL:!MD5",
						}
					: {}),
			},
			(res) => {
				const chunks: Buffer[] = [];

				res.on("data", (chunk: Buffer | string) => {
					if (typeof chunk === "string") {
						chunks.push(Buffer.from(chunk, "utf8"));
						return;
					}
					chunks.push(chunk);
				});

				res.on("end", async () => {
					if (
						followRedirects &&
						[301, 302, 303, 307, 308].includes(res.statusCode || 0)
					) {
						const location = res.headers.location;
						if (location && redirectCount < maxRedirects) {
							console.log(
								`Following redirect (${redirectCount + 1}/${maxRedirects}): ${url} -> ${location}`,
							);

							req.destroy();

							try {
								const redirectUrl = new URL(location, url).toString();
								let redirectOptions: RequestInit & RetryOptions = options;

								if (res.statusCode === 303) {
									const redirectHeaders: Record<string, string> = {};
									if (options.headers) {
										for (const [key, value] of Object.entries(
											options.headers as Record<string, unknown>,
										)) {
											const lowerKey = key.toLowerCase();
											if (
												lowerKey !== "content-type" &&
												lowerKey !== "content-length"
											) {
												redirectHeaders[key] = String(value);
											}
										}
									}

									redirectOptions = {
										...options,
										method: "GET",
										body: undefined,
										headers: redirectHeaders,
									};
								}

								const redirectResponse = await makeRequest(
									redirectUrl,
									redirectOptions,
									retryCount,
									redirectCount + 1,
								);
								resolve(redirectResponse);
							} catch (error) {
								reject(error);
							}
							return;
						}

						if (redirectCount >= maxRedirects) {
							console.warn(
								`Max redirects (${maxRedirects}) exceeded for: ${url}`,
							);
						}
					}

					const responseBody = Buffer.concat(chunks);
					const response: CustomResponse = {
						ok: res.statusCode
							? res.statusCode >= 200 && res.statusCode < 300
							: false,
						status: res.statusCode || 0,
						statusText: res.statusMessage || "",
						headers: Object.fromEntries(
							Object.entries(res.headers).map(([key, value]) => [
								key,
								Array.isArray(value) ? value.join(", ") : value || "",
							]),
						),
						text: async () => responseBody.toString("utf8"),
						json: async () => {
							try {
								return JSON.parse(responseBody.toString("utf8"));
							} catch (error) {
								throw new Error(
									`Failed to parse JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
								);
							}
						},
						arrayBuffer: async () =>
							responseBody.buffer.slice(
								responseBody.byteOffset,
								responseBody.byteOffset + responseBody.byteLength,
							),
					};

					resolve(response);
				});
			},
		);

		req.on("error", async (error: NodeError) => {
			const shouldRetry =
				retryCount < maxRetries &&
				(error.code === "ECONNRESET" ||
					error.code === "ETIMEDOUT" ||
					error.code === "ECONNREFUSED" ||
					error.code === "EHOSTUNREACH");

			if (shouldRetry) {
				console.warn(`请求失败，正在重试 (${retryCount + 1}/${maxRetries}):`, {
					url,
					error: {
						name: error.name,
						message: error.message,
						code: error.code,
					},
				});

				try {
					await sleep(retryDelay * (retryCount + 1));
					const response = await makeRequest(
						url,
						options,
						retryCount + 1,
						redirectCount,
					);
					resolve(response);
				} catch (retryError) {
					reject(retryError);
				}
			} else {
				console.error("请求错误:", {
					url,
					error: {
						name: error.name,
						message: error.message,
						code: error.code,
						stack: error.stack,
					},
				});
				reject(error);
			}
		});

		req.on("timeout", () => {
			req.destroy();
			const error = new Error("请求超时");
			(error as NodeError).code = "ETIMEDOUT";
			req.emit("error", error);
		});

		if (mergedOptions.body) {
			req.write(mergedOptions.body as string | Uint8Array);
		}

		req.end();
	});
}

export async function customFetch(
	url: string,
	options: RequestInit & RetryOptions = {},
): Promise<CustomResponse> {
	return makeRequest(url, options);
}
