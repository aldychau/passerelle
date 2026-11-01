import yauzl from 'yauzl';
import yazl from 'yazl';
import type { z } from 'zod';
import { ECHANGE_LIMITS, RELEVE_LIMITS } from '@passerelle/shared';
import { badRequest } from './errors.js';

// Archives d'échange (docs/ECHANGE.md). Une archive importée vient de l'extérieur : rien de ce qu'elle déclare n'est cru.

export interface ExchangeArchive {
  json: unknown;
  releve?: unknown;
  /** Médias lus et vérifiés par leur contenu, par chemin dans l'archive. */
  files: Map<string, Buffer>;
}

const NAME = /^(images|videos)\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

/** Valide le contenu d'une archive ; le refus dit quel champ est en cause. */
export function parseExchange<T extends z.ZodType>(schema: T, json: unknown): z.infer<T> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw badRequest(`Fichier refusé (${issue?.path.join('.') || 'en-tête'}) : ${issue?.message ?? 'contenu invalide'}`);
}

/** Le contenu réel d'un média : signature JPEG, PNG, WebP ou MP4, jamais l'extension. */
export function mediaKind(data: Buffer): 'jpeg' | 'png' | 'webp' | 'mp4' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (data.length >= 12 && data.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  return null;
}

const limitOf = (name: string): number => (name === 'releve.json' ? RELEVE_LIMITS.bytes : name === 'echange.json' ? ECHANGE_LIMITS.json : name.startsWith('videos/') ? ECHANGE_LIMITS.video : ECHANGE_LIMITS.image);

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // compté à la lecture : la taille annoncée par l'archive ne prouve rien
        if (size > limit) stream.destroy(new Error('trop lourd'));
        else chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

/** Ouvre une archive d'échange. Tout écart (fichier inattendu, trop lourd, média au contenu inconnu) la refuse entière. */
export function readExchangeArchive(data: Buffer, options: { media?: boolean; releve?: boolean } = {}): Promise<ExchangeArchive> {
  if (data.length > ECHANGE_LIMITS.archive) throw badRequest('Archive trop lourde.');
  const media = options.media ?? true;
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
      if (err) return reject(badRequest("Ce fichier n'est pas une archive d'échange lisible."));
      let json: unknown;
      let releve: unknown;
      const names = new Set<string>();
      let entries = 0;
      // somme des tailles annoncées (et vérifiées à la lecture) : une petite archive peut cacher des Go de zéros compressés
      let declaredTotal = 0;
      const files = new Map<string, Buffer>();
      const fail = (message: string) => { zip.close(); reject(badRequest(message)); };

      zip.on('error', () => fail("Ce fichier n'est pas une archive d'échange lisible."));
      zip.on('end', () => {
        if (json === undefined) return reject(badRequest('Archive sans echange.json.'));
        resolve({ json, releve, files });
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (++entries > ECHANGE_LIMITS.entries) return fail("Trop de fichiers dans l'archive.");
        const name = entry.fileName;
        // les dossiers de l'archive n'apportent rien ; tout autre nom que ceux prévus est refusé (chemins, fichiers cachés…)
        if (name === 'images/' || name === 'videos/') return zip.readEntry();
        if (name !== 'echange.json' && !(options.releve && name === 'releve.json') && (!media || !NAME.test(name))) return fail(`Fichier inattendu dans l'archive : ${name.slice(0, 80)}`);
        if (entry.uncompressedSize > limitOf(name)) return fail(`Fichier trop lourd : ${name}`);
        declaredTotal += entry.uncompressedSize;
        if (declaredTotal > ECHANGE_LIMITS.archive) return fail('Archive trop lourde une fois ouverte.');
        if (name === 'echange.json' && json !== undefined) return fail('echange.json présent deux fois.');
        if (names.has(name)) return fail(`Fichier present deux fois : ${name}`);
        names.add(name);
        if (files.has(name)) return fail(`Fichier présent deux fois : ${name}`);
        readEntry(zip, entry, limitOf(name)).then(content => {
          if (name === 'echange.json' || name === 'releve.json') {
            try {
              const value: unknown = JSON.parse(content.toString('utf8'));
              if (name === 'releve.json') releve = value; else json = value;
            } catch {
              return fail('echange.json illisible.');
            }
          } else {
            if (!mediaKind(content)) return fail(`Contenu non reconnu : ${name}`);
            files.set(name, content);
          }
          zip.readEntry();
        }, () => fail(`Fichier illisible ou trop lourd : ${name}`));
      });
      zip.readEntry();
    });
  });
}

/** Écrit une archive d'échange ; les médias sont déjà compressés, ils y sont simplement rangés. */
export function writeExchangeArchive(json: unknown, files: Map<string, Buffer> = new Map()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(json, null, 2)), 'echange.json');
    for (const [name, data] of files) zip.addBuffer(data, name, { compress: false });
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
