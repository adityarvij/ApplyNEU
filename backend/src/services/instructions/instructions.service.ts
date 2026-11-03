import { pool } from '../../db/index.ts';
import { redis } from '../../db/redis.ts';
import { EXTRACTION_VERSION, INSTRUCTION_KINDS } from './instructions.prompt.ts';

export type InstructionKind = typeof INSTRUCTION_KINDS[number];

export type EmployerInstruction = { kind: InstructionKind; instruction: string; description: string };

const INSTRUCTIONS_CACHE_TTL = 7 * 24 * 3600;

const instructionsCacheKey = (description_hash: string) => `instructions:${EXTRACTION_VERSION}:${description_hash}`;

export const NON_REQUIRED_TASK_PATTERN =
    /\b(ad[\s-]?block(?:er)?|pop[\s-]?up(?: blocker)?|clear (?:your )?cache|cookies?|switch (?:to )?(?:another|different) browser|disable (?:browser )?extensions?|enable javascript|incognito|private mode|vpn|proxy|firewall|antivirus|troubleshoot|workaround|tip|optional|recommended|preference)\b/i;

/**
 * Filters and deduplicates a raw list of employer instruction objects.
 * Strips items that match NON_REQUIRED_TASK_PATTERN (browser tips, optional advice, etc.)
 * and any instruction/description pair that is an exact case-insensitive duplicate.
 * An unrecognized or missing kind becomes 'other'.
 */
export const normalizeEmployerInstructions = (input: any): EmployerInstruction[] => {
  if (!Array.isArray(input)) return [];

  const dedup = new Set<string>();
  return input
    .map((item: any) => {
      if (!item || typeof item !== 'object') return null;
      const instruction = String(item.instruction ?? '').trim();
      const description = String(item.description ?? '').trim();
      if (!instruction || !description) return null;
      if (NON_REQUIRED_TASK_PATTERN.test(`${instruction} ${description}`)) return null;
      const key = `${instruction.toLowerCase()}::${description.toLowerCase()}`;
      if (dedup.has(key)) return null;
      dedup.add(key);
      const kind: InstructionKind = INSTRUCTION_KINDS.includes(item.kind) ? item.kind : 'other';
      return { kind, instruction, description };
    })
    .filter((v: EmployerInstruction | null): v is EmployerInstruction => !!v);
};

const URL_HOST = /https?:\/\/([^/\s?#:]+)/i;
const EMAIL_DOMAIN = /[^\s@]+@([A-Za-z0-9.-]+\.[A-Za-z]+)/;

/**
 * The site or mail domain a step sends the applicant to: the host of the first URL in the
 * text, else the domain of the first email address, lowercased and without a leading www.
 * @returns the domain, or null when the text has neither
 */
export const destinationDomain = (text: string): string | null => {
  const host = text.match(URL_HOST)?.[1] ?? text.match(EMAIL_DOMAIN)?.[1];
  return host ? host.toLowerCase().replace(/^www\./, '') : null;
};

/**
 * Returns the instructions already extracted for this posting text under the current
 * EXTRACTION_VERSION in extraction order, or null when it hasn't been extracted yet. An empty
 * array is a real result: the posting was extracted and requires nothing. Redis is checked first and filled
 * from Postgres hits; misses are not cached. A Redis failure falls through to Postgres, and
 * a Postgres failure is logged and treated as a miss, so the caller extracts instead of failing.
 */
export const getInstructions = async (description_hash: string): Promise<EmployerInstruction[] | null> => {
  const cacheKey = instructionsCacheKey(description_hash);
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached !== null) return JSON.parse(cached);
  try {
    const result = await pool.query(
      `
        SELECT i.kind, i.instruction, i.description
        FROM instruction_extractions e
        LEFT JOIN job_instructions i
          ON i.description_hash = e.description_hash AND i.extraction_version = e.extraction_version
        WHERE e.description_hash = $1 AND e.extraction_version = $2
        ORDER BY i.source, i.position;
      `,
      [description_hash, EXTRACTION_VERSION]
    );
    const found = result.rows.length > 0;
    console.log(`[instructions] memo ${found ? 'hit' : 'miss'} description_hash=${description_hash}`);
    if (!found) return null;
    const instructions: EmployerInstruction[] = result.rows.filter((row) => row.kind !== null);
    await redis.set(cacheKey, JSON.stringify(instructions), 'EX', INSTRUCTIONS_CACHE_TTL).catch(() => {});
    return instructions;
  } catch (error) {
    console.error(`[instructions] memo read failed description_hash=${description_hash}:`, error);
    return null;
  }
};

/**
 * Returns the ids of the instructions stored for this posting text under the current
 * EXTRACTION_VERSION in extraction order, or null when it hasn't been extracted yet. Reads
 * Postgres only, since the ids are what a job's thread keeps, and a read failure is thrown so
 * the node calling it retries instead of keeping no instructions.
 */
export const getInstructionIds = async (description_hash: string): Promise<string[] | null> => {
  const result = await pool.query(
    `
      SELECT i.instruction_id
      FROM instruction_extractions e
      LEFT JOIN job_instructions i
        ON i.description_hash = e.description_hash AND i.extraction_version = e.extraction_version
      WHERE e.description_hash = $1 AND e.extraction_version = $2
      ORDER BY i.source, i.position;
    `,
    [description_hash, EXTRACTION_VERSION]
  );
  if (!result.rows.length) return null;
  return result.rows.filter((row) => row.instruction_id !== null).map((row) => row.instruction_id);
};

/**
 * Loads the instructions with these ids in the order given, whatever version they were
 * extracted under, so a thread keeps the steps it decided on after a re-extraction.
 */
export const getInstructionsByIds = async (
  instruction_ids: string[]
): Promise<(EmployerInstruction & { instruction_id: string })[]> => {
  if (!instruction_ids.length) return [];
  const result = await pool.query(
    `
      SELECT i.instruction_id, i.kind, i.instruction, i.description
      FROM unnest($1::uuid[]) WITH ORDINALITY AS wanted(instruction_id, position)
      JOIN job_instructions i ON i.instruction_id = wanted.instruction_id
      ORDER BY wanted.position;
    `,
    [instruction_ids]
  );
  return result.rows;
};

/**
 * Stores a posting's extracted instructions under the current EXTRACTION_VERSION: the header
 * and one job_instructions row per step, in one statement so neither is written without the
 * other. The first write wins, since the steps are only inserted under a header this
 * statement created, so two users extracting the same posting at once is harmless; only the
 * winner writes Redis, so Redis always matches the stored rows. A write failure is logged and
 * never thrown, since the caller already has the instructions.
 * @param model - Model that extracted them
 */
export const saveInstructions = async (description_hash: string, instructions: EmployerInstruction[], model: string) => {
  try {
    const result = await pool.query(
      `
        WITH header AS (
          INSERT INTO instruction_extractions (description_hash, extraction_version, model)
          VALUES ($1, $2, $3)
          ON CONFLICT (description_hash, extraction_version) DO NOTHING
          RETURNING description_hash, extraction_version
        ), steps AS (
          INSERT INTO job_instructions
            (description_hash, extraction_version, kind, instruction, description, destination_domain, source, position)
          SELECT header.description_hash, header.extraction_version,
                 step.kind, step.instruction, step.description, step.destination_domain, 'description', step.position
          FROM header
          CROSS JOIN unnest($4::instruction_kind[], $5::text[], $6::text[], $7::text[])
            WITH ORDINALITY AS step(kind, instruction, description, destination_domain, position)
        )
        SELECT EXISTS (SELECT 1 FROM header) AS won;
      `,
      [
        description_hash,
        EXTRACTION_VERSION,
        model,
        instructions.map((step) => step.kind),
        instructions.map((step) => step.instruction),
        instructions.map((step) => step.description),
        instructions.map((step) => destinationDomain(step.description)),
      ]
    );
    if (result.rows[0]?.won) {
      await redis.set(instructionsCacheKey(description_hash), JSON.stringify(instructions), 'EX', INSTRUCTIONS_CACHE_TTL).catch(() => {});
    }
  } catch (error) {
    console.error(`[instructions] memo write failed description_hash=${description_hash}:`, error);
  }
};
