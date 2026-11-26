function pktLine(text: string): string {
  return (text.length + 4).toString(16).padStart(4, "0") + text;
}

export function serveRefusingGit() {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => undefined },
    (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/info/refs")) {
        return new Response(
          pktLine("version 2\n") + pktLine("agent=fixture\n") +
            pktLine("ls-refs\n") + pktLine("fetch=shallow filter\n") +
            "0000",
          {
            headers: {
              "content-type": "application/x-git-upload-pack-advertisement",
            },
          },
        );
      }
      return new Response(
        pktLine(
          "ERR upload-pack: not our ref 0123456789abcdef0123456789abcdef01234567\n",
        ),
        { headers: { "content-type": "application/x-git-upload-pack-result" } },
      );
    },
  );
  return {
    url: `http://127.0.0.1:${server.addr.port}/repository.git`,
    close: () => server.shutdown(),
  };
}
