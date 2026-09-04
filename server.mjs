import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '4173', 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(message);
}

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl ?? '/', `http://${host}:${port}`);
  const decodedPath = decodeURIComponent(url.pathname);
  const requestedPath = decodedPath.endsWith('/')
    ? `${decodedPath}index.html`
    : decodedPath;
  const absolutePath = resolve(rootDirectory, `.${requestedPath}`);

  if (
    absolutePath !== rootDirectory
    && !absolutePath.startsWith(`${rootDirectory}${sep}`)
  ) {
    return null;
  }

  return absolutePath;
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method Not Allowed');
    return;
  }

  if (request.url?.split('?', 1)[0] === '/favicon.ico') {
    response.writeHead(204, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }

  let filePath;
  try {
    filePath = resolveRequestPath(request.url);
  } catch {
    sendText(response, 400, 'Bad Request');
    return;
  }

  if (!filePath) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      sendText(response, 404, 'Not Found');
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': body.byteLength,
      'Content-Type': contentTypes.get(extname(filePath).toLowerCase())
        ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      sendText(response, 404, 'Not Found');
      return;
    }

    console.error(error);
    sendText(response, 500, 'Internal Server Error');
  }
});

server.listen(port, host, () => {
  console.log(`Cornell Notebook available at http://${host}:${port}`);
});

function shutDown() {
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);
