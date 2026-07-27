// M5 — boucle canon : inventions du DO → canon_proposals au finish,
// puis accept (merge dans canon_md) / reject via /api/bibles/:id/proposals.

import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertAnthropicMockConsumed,
  installAnthropicMock,
  mockAnthropicStream,
  mockAnthropicText,
} from "./anthropic-mock";

const BASE = "http://loreforge.test";

beforeAll(() => {
  installAnthropicMock();
});

afterEach(() => {
  assertAnthropicMockConsumed();
});

async function login(email: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const { dev_link } = (await res.json()) as { dev_link: string };
  const cb = await SELF.fetch(dev_link, { redirect: "manual" });
  return (cb.headers.get("set-cookie") ?? "").split(";")[0];
}

async function post(
  cookie: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function get(cookie: string, path: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, { headers: { cookie } });
}

async function createBible(cookie: string): Promise<string> {
  const res = await post(cookie, "/api/bibles", {
    markdown: "# Les Mondes Fêlés\n\nLa magie vient des failles.",
  });
  const { id } = (await res.json()) as { id: string };
  return id;
}

interface Proposal {
  id: string;
  session_id: string;
  axis: string;
  content_md: string;
  status: string;
}

/** Session complète : setup avec 2 inventions dans le flux, puis finish. */
async function playSessionWithInventions(
  cookie: string,
  bibleId: string,
): Promise<{ sessionId: string; finishBody: Record<string, unknown> }> {
  const created = await post(cookie, "/api/sessions", {
    bible_id: bibleId,
    format: "oneshot",
  });
  expect(created.status).toBe(201);
  const { session_id } = (await created.json()) as { session_id: string };

  mockAnthropicStream([
    "La cité s'éveille. ",
    '<invention axis="geography">La cité-pont de Vhal enjambe la faille.</invention>',
    '<invention axis="characters">Maître Orin, cartographe aveugle.</invention>',
  ]);
  const setup = await post(cookie, `/api/sessions/${session_id}/setup`, {
    answers: [],
  });
  expect(setup.headers.get("content-type")).toContain("text/event-stream");
  await setup.text(); // draine le SSE

  mockAnthropicText("## Résumé\n\nUne courte session.");
  const finish = await post(cookie, `/api/sessions/${session_id}/finish`);
  expect(finish.status).toBe(200);
  return {
    sessionId: session_id,
    finishBody: (await finish.json()) as Record<string, unknown>,
  };
}

describe("boucle canon", () => {
  it("le finish convertit les inventions en propositions pending", async () => {
    const cookie = await login("canon@example.com");
    const bibleId = await createBible(cookie);
    const { sessionId, finishBody } = await playSessionWithInventions(
      cookie,
      bibleId,
    );

    const returned = finishBody.proposals as Proposal[];
    expect(returned).toHaveLength(2);
    expect(returned.every((p) => p.status === "pending")).toBe(true);

    const res = await get(cookie, `/api/bibles/${bibleId}/proposals`);
    expect(res.status).toBe(200);
    const { proposals } = (await res.json()) as { proposals: Proposal[] };
    expect(proposals).toHaveLength(2);
    expect(proposals[0].axis).toBe("geography");
    expect(proposals[0].content_md).toContain("cité-pont de Vhal");
    expect(proposals[1].axis).toBe("characters");
    expect(proposals.every((p) => p.session_id === sessionId)).toBe(true);

    // Filtres status et session_id.
    const pending = await get(
      cookie,
      `/api/bibles/${bibleId}/proposals?status=accepted`,
    );
    expect(
      ((await pending.json()) as { proposals: Proposal[] }).proposals,
    ).toHaveLength(0);
    const bySession = await get(
      cookie,
      `/api/bibles/${bibleId}/proposals?session_id=${sessionId}`,
    );
    expect(
      ((await bySession.json()) as { proposals: Proposal[] }).proposals,
    ).toHaveLength(2);
  });

  it("accept fusionne dans canon_md, reject marque sans toucher au canon", async () => {
    const cookie = await login("canon2@example.com");
    const bibleId = await createBible(cookie);
    await playSessionWithInventions(cookie, bibleId);

    const { proposals } = (await (
      await get(cookie, `/api/bibles/${bibleId}/proposals`)
    ).json()) as { proposals: Proposal[] };
    const [geo, chars] = proposals;

    const accepted = await post(
      cookie,
      `/api/bibles/${bibleId}/proposals/${geo.id}`,
      { action: "accept" },
    );
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as {
      proposal: Proposal;
      canon_md: string;
    };
    expect(acceptedBody.proposal.status).toBe("accepted");
    // L'ajout rejoint la section de base de son axe, marqué comme canonisé —
    // pas de section fourre-tout tant que la base existe.
    expect(acceptedBody.canon_md).toContain("## Géographie & lieux");
    expect(acceptedBody.canon_md).toContain(
      "**Canonisé en session :** La cité-pont de Vhal",
    );
    expect(acceptedBody.canon_md).not.toContain("## Canonisé en session");

    const rejected = await post(
      cookie,
      `/api/bibles/${bibleId}/proposals/${chars.id}`,
      { action: "reject" },
    );
    expect(rejected.status).toBe(200);

    // Le canon stocké contient l'accepté, pas le rejeté.
    const bible = (await (
      await get(cookie, `/api/bibles/${bibleId}`)
    ).json()) as { canon_md: string };
    expect(bible.canon_md).toContain("cité-pont de Vhal");
    expect(bible.canon_md).not.toContain("Maître Orin");

    // Re-trancher → 409, et plus rien en pending.
    const again = await post(
      cookie,
      `/api/bibles/${bibleId}/proposals/${geo.id}`,
      { action: "reject" },
    );
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe(
      "already_decided",
    );
    const left = (await (
      await get(cookie, `/api/bibles/${bibleId}/proposals?status=pending`)
    ).json()) as { proposals: Proposal[] };
    expect(left.proposals).toHaveLength(0);
  });

  it("accept sans section d'axe : repli sur « Canonisé en session »", async () => {
    const cookie = await login("canon3@example.com");
    const bibleId = await createBible(cookie);
    await playSessionWithInventions(cookie, bibleId);

    // Init des sections puis suppression de la base Géographie : l'axe n'a
    // plus de section d'accueil.
    const { sections } = (await (
      await get(cookie, `/api/bibles/${bibleId}/sections`)
    ).json()) as { sections: Array<{ id: string; axis: string | null }> };
    const geoSection = sections.find((s) => s.axis === "geography")!;
    await SELF.fetch(`${BASE}/api/bibles/${bibleId}/sections/${geoSection.id}`, {
      method: "DELETE",
      headers: { cookie },
    });

    const { proposals } = (await (
      await get(cookie, `/api/bibles/${bibleId}/proposals`)
    ).json()) as { proposals: Proposal[] };
    const geo = proposals.find((p) => p.axis === "geography")!;
    const accepted = await post(
      cookie,
      `/api/bibles/${bibleId}/proposals/${geo.id}`,
      { action: "accept" },
    );
    expect(accepted.status).toBe(200);
    const { canon_md } = (await accepted.json()) as { canon_md: string };
    expect(canon_md).toContain("## Canonisé en session");
    expect(canon_md).toContain("### Géographie");
    expect(canon_md).toContain("cité-pont de Vhal");
  });

  it("édition avant validation : accept avec content_md remplace le texte canonisé", async () => {
    const cookie = await login("edit5@example.com");
    const bibleId = await createBible(cookie);
    await playSessionWithInventions(cookie, bibleId);
    const { proposals } = (await (
      await get(cookie, `/api/bibles/${bibleId}/proposals`)
    ).json()) as { proposals: Proposal[] };

    const accepted = await post(cookie, `/api/bibles/${bibleId}/proposals/${proposals[0].id}`, {
      action: "accept",
      content_md: "La cité-pont de Vhal, RÉÉCRITE par l'auteur.",
    });
    expect(accepted.status).toBe(200);
    const { canon_md } = (await accepted.json()) as { canon_md: string };
    expect(canon_md).toContain("RÉÉCRITE par l'auteur");
  });

  it("from-comment : un retour sur un passage crée une proposition source=comment", async () => {
    const cookie = await login("fc@example.com");
    const bibleId = await createBible(cookie);
    const { sessionId } = await playSessionWithInventions(cookie, bibleId);

    mockAnthropicText(
      JSON.stringify({ relevant: true, axis: "tone", content_md: "Le registre se fait plus sombre." }),
    );
    const res = await post(cookie, `/api/bibles/${bibleId}/proposals/from-comment`, {
      session_id: sessionId,
      passage: "Une scène lumineuse.",
      comment: "trop clair par rapport à ma bible",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relevant: boolean; proposal: Proposal & { source: string; source_comment: string } };
    expect(body.relevant).toBe(true);
    expect(body.proposal.source).toBe("comment");
    expect(body.proposal.source_comment).toContain("trop clair");
    expect(body.proposal.content_md).toContain("plus sombre");

    // La proposition apparaît bien dans la liste, avec sa source exposée.
    const listed = (await (
      await get(cookie, `/api/bibles/${bibleId}/proposals`)
    ).json()) as { proposals: Array<{ source: string }> };
    expect(listed.proposals.some((p) => p.source === "comment")).toBe(true);
  });

  it("from-comment : un retour sans conséquence de canon ne crée pas de proposition", async () => {
    const cookie = await login("fc2@example.com");
    const bibleId = await createBible(cookie);
    const { sessionId } = await playSessionWithInventions(cookie, bibleId);

    mockAnthropicText(JSON.stringify({ relevant: false, axis: "plots", content_md: "" }));
    const res = await post(cookie, `/api/bibles/${bibleId}/proposals/from-comment`, {
      session_id: sessionId,
      passage: "Kass sourit.",
      comment: "j'adore ce personnage",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relevant: boolean; proposal: unknown };
    expect(body.relevant).toBe(false);
    expect(body.proposal).toBeNull();
  });

  it("from-feedback : note le retour et propose une modif si pertinent", async () => {
    const cookie = await login("ff@example.com");
    const bibleId = await createBible(cookie);
    const { sessionId } = await playSessionWithInventions(cookie, bibleId);

    mockAnthropicText(
      JSON.stringify({ relevant: true, axis: "plots", content_md: "Une trame de fond émerge." }),
    );
    const res = await post(cookie, `/api/bibles/${bibleId}/proposals/from-feedback`, {
      session_id: sessionId,
      comment: "creuser la piste de la faille",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { noted: boolean; proposal: Proposal | null };
    expect(body.noted).toBe(true);
    expect(body.proposal?.content_md).toContain("trame de fond");
  });

  it("valide l'action, le statut de filtre et la propriété de la bible", async () => {
    const alice = await login("alice5@example.com");
    const bob = await login("bob5@example.com");
    const bibleId = await createBible(alice);
    await playSessionWithInventions(alice, bibleId);
    const { proposals } = (await (
      await get(alice, `/api/bibles/${bibleId}/proposals`)
    ).json()) as { proposals: Proposal[] };

    expect(
      (await get(alice, `/api/bibles/${bibleId}/proposals?status=nope`)).status,
    ).toBe(400);
    expect(
      (
        await post(alice, `/api/bibles/${bibleId}/proposals/${proposals[0].id}`, {
          action: "merge",
        })
      ).status,
    ).toBe(400);
    expect((await get(bob, `/api/bibles/${bibleId}/proposals`)).status).toBe(404);
    expect(
      (
        await post(bob, `/api/bibles/${bibleId}/proposals/${proposals[0].id}`, {
          action: "accept",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post(alice, `/api/bibles/${bibleId}/proposals/inconnu`, {
          action: "accept",
        })
      ).status,
    ).toBe(404);
  });
});
