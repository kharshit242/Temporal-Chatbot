/**
 * src/agent/nvidia.ts
 *
 * Central reusable NVIDIA NIM client abstraction using the OpenAI Node SDK.
 * Base URL: https://integrate.api.nvidia.com/v1
 * Model: nvidia/nemotron-3.5-super-vl-120b-a12b
 */

import OpenAI from "openai";
import { Config } from "../config.js";

let _cachedClient: OpenAI | null = null;
let _cachedKey: string | null = null;
let _cachedBaseUrl: string | null = null;

/**
 * Returns an OpenAI client configured for NVIDIA NIM.
 * Dynamically updates if API key or base URL change in environment or test runners.
 */
export function getNvidiaClient(): OpenAI {
  const apiKey = Config.nvidia.apiKey;
  const baseURL = Config.nvidia.baseUrl;

  if (!_cachedClient || _cachedKey !== apiKey || _cachedBaseUrl !== baseURL) {
    _cachedClient = new OpenAI({
      apiKey: apiKey || "missing-nvidia-api-key",
      baseURL,
      // Forward fetch to globalThis.fetch so testing/spying intercepts properly
      fetch: (url, init) => globalThis.fetch(url, init)
    });
    _cachedKey = apiKey;
    _cachedBaseUrl = baseURL;
  }

  return _cachedClient;
}

/**
 * Shared NVIDIA client instance.
 * Forwards requests to the active client.
 */
export const nvidiaClient = {
  get chat() {
    return getNvidiaClient().chat;
  }
};

