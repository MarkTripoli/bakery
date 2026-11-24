import { assertEquals } from "@std/assert";
import {
  call,
  CHECKLIST_HTML,
  install,
  pagesManifest,
  publishWithPages,
  withPluginFixture,
} from "../helpers/plugin-pages-fixture.ts";
import {
  type BrokerOperation,
  createPluginBroker,
  mintBrokerToken,
} from "../../apps/server/src/modules/catalog/plugin-broker.ts";
import { createPostgresInstallAuthority } from "../../apps/server/src/modules/catalog/plugin-broker-postgres.ts";

/**
 * The broker against the real install tables (#29, B14.02, AC2): its answer
 * follows what an install holds right now, through the same routes a person
 * uses to turn a plugin off or remove it.
 */

const KEY = crypto.getRandomValues(new Uint8Array(32));
const EPOCH = "boot-1";
const PAGE = { id: "checklist", title: "Checklist", file: "checklist.html" };

Deno.test("the broker follows the install: allowed while on, refused the moment it is off or removed", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishWithPages(
      fixture,
      store,
      pagesManifest([PAGE]),
      { "checklist.html": CHECKLIST_HTML },
    );
    assertEquals(published.response.status, 201);
    const installId = await install(fixture, published);

    const ran: string[] = [];
    const read: BrokerOperation = {
      name: "state.read",
      run: (_claims, args) => {
        ran.push(String(args.key));
        return Promise.resolve({ value: 1 });
      },
    };
    const write: BrokerOperation = {
      name: "state.write",
      run: () => {
        ran.push("write");
        return Promise.resolve({});
      },
    };
    const broker = createPluginBroker({
      key: KEY,
      epoch: EPOCH,
      authority: createPostgresInstallAuthority(fixture.pgDatabase),
      operations: [read, write],
    });
    const { token } = await mintBrokerToken(KEY, {
      runEnvironment: "live",
      epoch: EPOCH,
      organizationId: fixture.organizationId,
      installId,
      jobId: "job-1",
      now: Date.now(),
      ttlMs: 60_000,
    });
    let sequence = 0;
    const ask = (operation: string) =>
      broker.call({
        token,
        installId,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          sequence: ++sequence,
          operation,
          args: { key: "k" },
        }),
      });

    assertEquals((await ask("state.read")).ok, true);
    // The manifest asked for state.read, not state.write, so write is refused
    // even though the host offers it.
    assertEquals(await ask("state.write"), {
      ok: false,
      denial: "not_granted",
    });
    assertEquals(ran, ["k"]);

    const off = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    assertEquals(off.status, 200, await off.clone().text());
    assertEquals(await ask("state.read"), { ok: false, denial: "install_off" });

    const back = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "enabled" },
    });
    assertEquals(back.status, 200, await back.clone().text());
    assertEquals((await ask("state.read")).ok, true);

    const removed = await call(fixture, `/v1/plugin-installs/${installId}`, {
      method: "PATCH",
      body: { status: "uninstalled" },
    });
    assertEquals(removed.status, 200, await removed.clone().text());
    assertEquals(await ask("state.read"), {
      ok: false,
      denial: "install_gone",
    });
    assertEquals(ran, ["k", "k"]);
  }));

Deno.test("a token minted for another organization finds no install here", () =>
  withPluginFixture(async (fixture, store) => {
    const published = await publishWithPages(
      fixture,
      store,
      pagesManifest([PAGE]),
      { "checklist.html": CHECKLIST_HTML },
    );
    const installId = await install(fixture, published);
    const broker = createPluginBroker({
      key: KEY,
      epoch: EPOCH,
      authority: createPostgresInstallAuthority(fixture.pgDatabase),
      operations: [{
        name: "state.read",
        run: () => Promise.resolve({}),
      }],
    });
    const { token } = await mintBrokerToken(KEY, {
      runEnvironment: "live",
      epoch: EPOCH,
      organizationId: crypto.randomUUID(),
      installId,
      jobId: "job-1",
      now: Date.now(),
      ttlMs: 60_000,
    });
    assertEquals(
      await broker.call({
        token,
        installId,
        body: JSON.stringify({
          requestId: "r1",
          sequence: 1,
          operation: "state.read",
          args: {},
        }),
      }),
      { ok: false, denial: "install_gone" },
    );
  }));
