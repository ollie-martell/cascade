/**
 * Initialises an SSE (Server-Sent Events) connection on the response object.
 * Returns { send, close } helpers.
 */
function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }
  }, 15000);

  const send = (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const close = () => {
    clearInterval(heartbeatInterval);
    if (!res.writableEnded) {
      res.end();
    }
  };

  res.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return { send, close };
}

module.exports = { initSSE };
