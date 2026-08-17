// Annexe de prompt tirée des tableaux de références (§8).
//
// La lecture d'ambiance d'un tableau dit l'intention VISUELLE de l'auteur :
// lumière, matières, époque, émotion dominante. Ce n'est pas du canon narratif
// — rien ne s'y établit — mais c'est une direction que l'analyse de richesse et
// le MJ doivent connaître. D'où une annexe commune, explicitement cadrée.

export interface MoodboardBrief {
  title: string;
  note: string | null;
  analysis_md: string | null;
}

/** Au-delà, l'annexe pèse plus qu'elle n'oriente. */
export const MAX_MOODBOARD_BOARDS = 6;
export const MAX_MOODBOARD_CHARS = 6000;

/** Annexe Markdown des tableaux analysés ; chaîne vide s'il n'y en a aucun. */
export function buildMoodboardAnnex(boards: MoodboardBrief[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const board of boards.slice(0, MAX_MOODBOARD_BOARDS)) {
    const analysis = (board.analysis_md ?? "").trim();
    if (analysis === "") continue; // tableau pas encore analysé
    const note = (board.note ?? "").trim();
    const block =
      `### ${board.title.trim() || "Sans titre"}\n` +
      (note ? `Intention de l'auteur : ${note}\n` : "") +
      analysis;
    if (used + block.length > MAX_MOODBOARD_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  if (blocks.length === 0) return "";

  return `== RÉFÉRENCES GRAPHIQUES (intention visuelle de l'auteur) ==
Lecture des tableaux d'images réunis par l'auteur pour cet univers. Ce n'est
PAS du canon : aucun fait, personnage ni lieu ne s'y établit, et rien ici ne
peut contredire la bible. C'est une direction sensible — lumière, matières,
époque, échelle, technologie ou magie apparentes, émotion dominante.

${blocks.join("\n\n")}`;
}

/** Charge les tableaux analysés d'une bible et en fait l'annexe de prompt. */
export async function loadMoodboardAnnex(
  db: D1Database,
  bibleId: string,
): Promise<string> {
  const rows = await db
    .prepare(
      `SELECT title, note, analysis_md FROM bible_moodboards
       WHERE bible_id = ? AND analysis_md IS NOT NULL AND analysis_md != ''
       ORDER BY sort_order LIMIT ?`,
    )
    .bind(bibleId, MAX_MOODBOARD_BOARDS)
    .all<MoodboardBrief>();
  return buildMoodboardAnnex(rows.results);
}
