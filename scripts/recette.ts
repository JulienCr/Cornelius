import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLimits, parseLimits, parseProtocol, type RecetteProtocol } from './recette-lib.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const protocolFile = resolve(projectRoot, 'tests/recette/protocol.json');

/**
 * Guide de passation de la recette §3 : il présente les étapes et attend la personne entre
 * chacune. Il ne produit aucun son, ne pilote ni la perception ni la session : c'est vous qui
 * posez les questions, le serveur ouvre la session par la présence réelle.
 */
async function main() {
  const argv = process.argv.slice(2);
  const list = argv.includes('--list');
  const protocol = applyLimits(
    parseProtocol(JSON.parse(readFileSync(protocolFile, 'utf8'))),
    parseLimits(argv),
  );

  const total =
    protocol.approaches +
    protocol.questions.length +
    protocol.interruptions.length +
    protocol.passages;
  console.log(`Recette Cornelius — ${total} étape(s).`);
  console.log(
    'Laissez le serveur tourner et restez face à la caméra : la session s’ouvre et se ferme ',
  );
  console.log('selon votre présence réelle. Répondez naturellement, puis validez chaque étape.');
  console.log('À la fin, lancez : pnpm mesures\n');

  if (list) {
    printProtocol(protocol);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await section(
      rl,
      'Approches',
      protocol.approaches,
      (index) =>
        `Approche ${index} : avancez et restez face à la caméra, la session doit s’ouvrir.`,
    );
    await section(rl, 'Questions', protocol.questions.length, (index) => {
      const step = protocol.questions[index - 1]!;
      return `Question ${index} — « ${step.text} »`;
    });
    await section(rl, 'Interruptions', protocol.interruptions.length, (index) => {
      const step = protocol.interruptions[index - 1]!;
      const question = protocol.questions[(index - 1) % protocol.questions.length];
      return (
        `Interruption ${index} — dites « ${question?.text ?? 'une question'} », ` +
        `puis coupez la réponse en disant « ${step.text} ».`
      );
    });
    await section(
      rl,
      'Passages de tiers',
      protocol.passages,
      (index) =>
        `Passage ${index} : un tiers traverse sans s’engager, aucune session ne doit s’ouvrir.`,
    );
  } finally {
    rl.close();
  }

  console.log('\nRecette terminée.');
  console.log('- Comptez la compréhension sur les questions (objectif 49/50).');
  console.log('- Comptez les ouvertures injustifiées pendant les passages de tiers.');
  console.log('Tableau §3 : pnpm mesures');
}

async function section(
  rl: ReturnType<typeof createInterface>,
  label: string,
  count: number,
  describe: (index: number) => string,
) {
  if (count === 0) return;
  console.log(`\n=== ${label} (${count}) ===`);
  for (let index = 1; index <= count; index++) {
    await rl.question(`${describe(index)}\n  Entrée pour l’étape suivante… `);
  }
}

function printProtocol(protocol: RecetteProtocol) {
  console.log('Approches :');
  for (let index = 1; index <= protocol.approaches; index++) console.log(`  ${index}. approche`);
  console.log('\nQuestions :');
  for (const [index, step] of protocol.questions.entries())
    console.log(`  ${index + 1}. ${step.text}`);
  console.log('\nInterruptions :');
  for (const [index, step] of protocol.interruptions.entries())
    console.log(`  ${index + 1}. couper par « ${step.text} »`);
  console.log('\nPassages de tiers :');
  for (let index = 1; index <= protocol.passages; index++) console.log(`  ${index}. passage`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
