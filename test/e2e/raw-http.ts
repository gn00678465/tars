/**
 * Answers each request with the bytes `replies` maps its path to, then closes the connection.
 * Bun.serve rewrites Content-Length and resets a stream that errors, so a response cut off
 * mid-body has to be written by hand. Returns the paths it was asked for.
 */
export function rawHttp(port: number, replies: Readonly<Record<string, string>>) {
  const hits: string[] = [];
  const listener = Bun.listen<{ received: string }>({
    hostname: "::",
    port,
    socket: {
      open(socket) {
        socket.data = { received: "" };
      },
      data(socket, chunk) {
        socket.data.received += chunk.toString("latin1");
        const received = socket.data.received;
        const headEnd = received.indexOf("\r\n\r\n");
        if (headEnd < 0) return;
        const length = Number(/^content-length: *(\d+)/im.exec(received)?.[1] ?? 0);
        // Closing with request bytes still unread would reset the connection instead.
        if (received.length < headEnd + 4 + length) return;
        const path = new URL(received.split(" ", 2)[1] ?? "/", "http://raw").pathname;
        hits.push(path);
        socket.end(
          replies[path] ??
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
      },
    },
  });
  return { hits, stop: () => listener.stop(true) };
}
