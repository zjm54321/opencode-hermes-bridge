// Exec inside the MCP container: neither listener is exposed to kubelet HTTP.
const urls = ['http://127.0.0.1:8790/health'];
if (!process.argv.includes('--live')) urls.push('http://127.0.0.1:8080/readyz');
try {
  const responses = await Promise.all(urls.map(url => fetch(url, { signal: AbortSignal.timeout(1500) })));
  process.exit(responses.every(response => response.ok) ? 0 : 1);
} catch { process.exit(1); }
