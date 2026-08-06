'use strict';

const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = Object.freeze({ name: 'mdmlight-bp-assistant', version: '1.0.0' });

function parseResponse(data) {
  if (typeof data !== 'string') return data;
  // Streamable HTTP may answer as SSE, where the payload sits on data: lines.
  if (!data.trimStart().startsWith('event:') && !data.trimStart().startsWith('data:')) {
    return JSON.parse(data);
  }
  const payload = data
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  return JSON.parse(payload);
}

/**
 * Minimal MCP Streamable HTTP client: enough to call a tool, nothing more.
 * Built on the Cloud SDK http-client so the server is reached through a BTP destination.
 */
function createMcpToolCaller({ destinationName, executeHttpRequest, timeout = 30000 }) {
  let sessionId = null;
  let initializing = null;

  async function post(body, extraHeaders = {}) {
    const response = await executeHttpRequest(
      { destinationName },
      {
        method: 'POST',
        url: '/mcp',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          ...extraHeaders
        },
        data: body,
        timeout
      }
    );
    const header = response?.headers?.['mcp-session-id'] || response?.headers?.['Mcp-Session-Id'];
    if (header) sessionId = header;
    return response;
  }

  async function initialize() {
    const response = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
      }
    });
    const parsed = parseResponse(response?.data);
    if (parsed?.error) throw new Error(`MCP initialize failed: ${parsed.error.message}`);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return parsed;
  }

  // One handshake per instance; a failed one is retried rather than cached.
  function ready() {
    if (sessionId) return Promise.resolve();
    if (!initializing) {
      initializing = initialize().catch((error) => {
        initializing = null;
        throw error;
      });
    }
    return initializing;
  }

  let nextId = 2;
  return async function callTool(name, args) {
    await ready();
    const response = await post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args }
    });
    const parsed = parseResponse(response?.data);
    if (parsed?.error) throw new Error(`MCP ${name} failed: ${parsed.error.message}`);
    const result = parsed?.result;
    if (result?.isError) throw new Error(`MCP ${name} returned an error result`);
    return result;
  };
}

module.exports = { PROTOCOL_VERSION, CLIENT_INFO, parseResponse, createMcpToolCaller };
