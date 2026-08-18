// Garde-fou du nombre de dés (SPEC §6).
//
// Le barème est explicite dans le prompt du MJ, mais son application reste
// intermittente : une action « pousser Reika à la faute en feignant
// l'inquiétude », tags comédie / provocation / lecture sociale, part à 1 dé
// alors que la fiche dit « roublarde et provocatrice, elle aime pousser ses
// adversaires à la faute » et que les sigils sont sa capacité. Avant de lancer,
// le serveur revérifie donc les bonus manquants — et n'ajoute jamais de malus :
// un oubli du MJ ne doit pas se retourner contre le joueur.

import {
  bonusDice,
  MAX_BONUS_DICE,
  type RollBonus,
  type RollRequest,
} from "./rules";

/** Les trois traits de fiche qui pèsent sur la poignée. */
export interface SheetTraits {
  temperament: string | null;
  ability: string | null;
  weakness: string | null;
}

/** Clés canoniques (§6bis) et libellés équivalents des schémas dérivés. */
const TRAIT_KEYS: Record<keyof SheetTraits, string[]> = {
  temperament: ["temperament", "temperamment", "caractere", "personnalite"],
  ability: ["ability", "capacite", "capaciteprincipale", "pouvoir", "don"],
  weakness: ["weakness", "faiblesse", "cout", "faille", "limite"],
};

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.filter((v) => typeof v === "string").join(", ").trim();
    return joined || null;
  }
  return null;
}

/**
 * Extrait tempérament / capacité / faiblesse d'une fiche. Le schéma étant
 * dérivé de la bible, les clés varient : on tente les clés canoniques, puis
 * tout champ dont le nom y ressemble.
 */
export function sheetTraits(characterSheet: unknown): SheetTraits {
  const traits: SheetTraits = { temperament: null, ability: null, weakness: null };
  let sheet = characterSheet;
  if (typeof sheet === "string") {
    try {
      sheet = JSON.parse(sheet);
    } catch {
      return traits;
    }
  }
  if (!sheet || typeof sheet !== "object") return traits;

  for (const [rawKey, rawValue] of Object.entries(sheet as Record<string, unknown>)) {
    const key = fold(rawKey);
    for (const trait of Object.keys(TRAIT_KEYS) as Array<keyof SheetTraits>) {
      if (traits[trait]) continue;
      if (TRAIT_KEYS[trait].some((k) => key === k || key.includes(k))) {
        traits[trait] = asText(rawValue);
      }
    }
  }
  return traits;
}

/**
 * Faut-il revérifier ? Seulement s'il reste un bonus possible à gagner : une
 * fiche muette ou un jet déjà crédité des deux bonus ne mérite pas l'appel.
 */
export function needsRollAudit(
  request: RollRequest,
  traits: SheetTraits,
): boolean {
  const missing = (["temperament", "ability"] as const).filter(
    (source) => traits[source] && !request.bonuses.some((b) => b.source === source),
  );
  return missing.length > 0;
}

export const ROLL_AUDIT_SYSTEM_PROMPT = `Tu vérifies le calcul d'un jet de dés dans une partie de jeu de rôle. On te donne l'action tentée et la fiche du personnage ; tu dis seulement si cette action mobilise son tempérament et/ou sa capacité principale.

- Réponds oui dès qu'il y a un recoupement net, même partiel, même sur un
  registre social plutôt que physique : une action de provocation coche un
  tempérament « provocatrice », une manœuvre autour d'un sigil coche une
  capacité « maîtrise des sigils ».
- Réponds non pour un rapprochement vague ou purement thématique : le trait
  doit réellement servir dans l'action tentée.
- "why" tient en une demi-phrase, et cite le fragment de fiche qui justifie.`;

export function buildRollAuditMessage(input: {
  reason: string;
  skills: string[];
  traits: SheetTraits;
}): string {
  const { reason, skills, traits } = input;
  return [
    `Action tentée : ${reason}`,
    skills.length > 0 ? `Registres de l'action : ${skills.join(", ")}` : null,
    "",
    `Tempérament du personnage : ${traits.temperament ?? "(non renseigné)"}`,
    `Capacité principale : ${traits.ability ?? "(non renseignée)"}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export const ROLL_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["temperament", "ability"],
  properties: {
    temperament: {
      type: "object",
      additionalProperties: false,
      required: ["applies", "why"],
      properties: {
        applies: { type: "boolean" },
        why: { type: "string", description: "Une demi-phrase, ou vide" },
      },
    },
    ability: {
      type: "object",
      additionalProperties: false,
      required: ["applies", "why"],
      properties: {
        applies: { type: "boolean" },
        why: { type: "string", description: "Une demi-phrase, ou vide" },
      },
    },
  },
} as const;

/**
 * Ajoute les bonus que la vérification confirme, et recalcule la poignée.
 * N'enlève jamais un bonus déjà accordé et n'ajoute jamais de malus.
 */
export function applyRollAudit(
  request: RollRequest,
  verdict: unknown,
  traits: SheetTraits,
): RollRequest {
  const body = (verdict ?? {}) as Record<
    string,
    { applies?: unknown; why?: unknown } | undefined
  >;
  const added: RollBonus[] = [];
  for (const source of ["temperament", "ability"] as const) {
    if (!traits[source]) continue;
    if (request.bonuses.some((b) => b.source === source)) continue;
    if (body[source]?.applies !== true) continue;
    const why = typeof body[source]?.why === "string" ? body[source]!.why! : "";
    added.push({ source, why: String(why).trim().slice(0, 120) });
  }
  if (added.length === 0) return request;

  const bonuses = [...request.bonuses, ...added];
  return {
    ...request,
    bonuses,
    bonus_dice: Math.min(MAX_BONUS_DICE, bonusDice(bonuses)),
  };
}
