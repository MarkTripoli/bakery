/** A fresh RSA key and self-signed X.509 certificate (PEM), made with `openssl`. */
export async function selfSignedCertificate(
  commonName = "bakery-test",
): Promise<{ privateKey: string; certificate: string }> {
  const dir = await Deno.makeTempDir({ prefix: "bakery-cert-" });
  try {
    const output = await new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${dir}/key.pem`,
        "-out",
        `${dir}/cert.pem`,
        "-days",
        "2",
        "-subj",
        `/CN=${commonName}`,
      ],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(new TextDecoder().decode(output.stderr));
    }
    return {
      privateKey: await Deno.readTextFile(`${dir}/key.pem`),
      certificate: await Deno.readTextFile(`${dir}/cert.pem`),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
