import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// A report-generation backend: every dependency is exercised by the handler.
// The same application source and dependency versions are used by every tool.
export const generate = async (count = 1, format = 'cjs') => {
  if (!['cjs', 'esm'].includes(format)) throw new Error('format must be cjs or esm');
  const root = resolve('generated', `reports-${count}${format === 'esm' ? '-esm' : ''}`);
  const banner = `import { createRequire as __benchCreateRequire } from 'node:module'; const require = __benchCreateRequire(import.meta.url);`;
  await mkdir(join(root, 'src'), { recursive: true });
  const manifest = {
    name: `reports-${count}`, private: true, version: '1.0.0', type: format === 'esm' ? 'module' : 'commonjs',
    dependencies: { exceljs: '4.4.0', 'pdf-lib': '1.17.1', docx: '9.9.0', ajv: '8.20.0', 'ajv-formats': '3.0.1', luxon: '3.7.2', 'fast-xml-parser': '5.11.2' },
    // Latest versions eligible under pnpm's release-age policy on this run.
    devDependencies: { 'aws-cdk': '2.1144.0', 'aws-cdk-lib': '2.272.0', constructs: '10.8.1', esbuild: '0.28.2', sst: '4.17.1', serverless: '4.43.0' }
  };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true, skipLibCheck: true } }, null, 2));
  const source = `import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { DateTime } from 'luxon';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { Document, Packer, Paragraph } from 'docx';

const revision = 'base';
const ajv = new Ajv();
addFormats(ajv);
const validate = ajv.compile({ type: 'object', properties: { customer: { type: 'string' }, date: { type: 'string', format: 'date' }, total: { type: 'number', minimum: 0 } }, required: ['customer', 'date', 'total'], additionalProperties: false });

export async function handler(event: Record<string, unknown> = {}) {
  const input = { customer: 'Acme', date: '2026-10-09', total: 125.5, ...event };
  if (!validate(input)) return { statusCode: 400, body: JSON.stringify(validate.errors) };
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Invoices');
  sheet.columns = [{ header: 'Customer', key: 'customer' }, { header: 'Date', key: 'date' }, { header: 'Total', key: 'total' }];
  sheet.addRow(input);
  const xlsx = await workbook.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(xlsx);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText(input.customer + ': ' + input.total, { font, size: 12 });
  const pdfBytes = await pdf.save();
  const xml = new XMLBuilder().build({ invoice: input });
  const invoice = new XMLParser().parse(xml).invoice;
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(input.customer + ': ' + input.total)] }] }));
  return { statusCode: 200, body: JSON.stringify({ revision, domain: '__DOMAIN__', customer: invoice.customer, rows: reloaded.getWorksheet('Invoices')!.rowCount, xlsxBytes: xlsx.byteLength, pdfBytes: pdfBytes.length, docxBytes: docx.length, date: DateTime.fromISO(input.date).toUTC().toISODate() }) };
}
`;
  for (let index = 0; index < count; index++) {
    await writeFile(join(root, 'src', `report-${index}.ts`), source.replace('__DOMAIN__', `report-${index}`));
  }
  const stack = ['resources:'];
  for (let index = 0; index < count; index++) stack.push(`  report${index}:`, '    type: function', '    properties:', '      packaging:', '        type: js-bundle', '        properties:', `          entryfilePath: ./src/report-${index}.ts`, '          disableSourceMaps: true', '          minify: true', '          minifyIdentifiers: false', `          outputModuleFormat: ${format}`, '      memory: 512', '      timeout: 30');
  await writeFile(join(root, 'stacktape.yml'), stack.join('\n') + '\n');
  await writeFile(join(root, 'cdk.json'), JSON.stringify({ app: 'node cdk-app.mjs' }));
  await writeFile(join(root, 'cdk-app.mjs'), `import { App, Stack, CfnOutput, Tags } from 'aws-cdk-lib';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
const app = new App();
const stack = new Stack(app, process.env.BENCH_PROJECT || 'reports-pilot', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-west-1' } });
Tags.of(stack).add('benchmark-owner', process.env.BENCH_OWNER || 'local');
for (let i = 0; i < ${count}; i++) {
  const fn = new NodejsFunction(stack, 'Report' + i, { entry: 'src/report-' + i + '.ts', runtime: Runtime.NODEJS_24_X, architecture: Architecture.X86_64, memorySize: 512, timeout: (await import('aws-cdk-lib')).Duration.seconds(30), bundling: { minify: true, sourceMap: false, format: '${format}', ${format === 'esm' ? `banner: ${JSON.stringify(banner)},` : ''} esbuildArgs: { '--minify-identifiers': 'false' }, externalModules: ['@aws-sdk/*'] } });
  new CfnOutput(stack, 'Function' + i, { value: fn.functionName });
}
app.synth();
`);
  const sls = ['service: reports-' + count, 'frameworkVersion: "4.43.0"', 'provider:', '  name: aws', '  runtime: nodejs24.x', '  region: eu-west-1', '  architecture: x86_64', '  memorySize: 512', '  timeout: 30', 'package:', '  individually: true', 'build:', '  esbuild:', '    bundle: true', '    minify: true', '    sourcemap: false', '    exclude:', '      - "@aws-sdk/*"', 'functions:'];
  for (let index = 0; index < count; index++) sls.push(`  report${index}:`, `    handler: src/report-${index}.handler`);
  await writeFile(join(root, 'serverless.yml'), sls.join('\n') + '\n');
  await writeFile(join(root, 'esbuild.config.cjs'), `module.exports = () => ({ minifyIdentifiers: false, minifySyntax: true, minifyWhitespace: true, format: '${format}', ${format === 'esm' ? `banner: { js: ${JSON.stringify(banner)} },` : ''} });\n`);
  await writeFile(join(root, 'serverless.yml'), sls.join('\n').replace('    bundle: true', '    configFile: ./esbuild.config.cjs\n    bundle: true').replace('    minify: true', '    minify: false') + '\n');
  await writeFile(join(root, 'sst.config.ts'), `export default $config({
  app(input) { return { name: process.env.BENCH_PROJECT || 'reports-pilot', removal: 'remove', protect: false, home: 'aws', providers: { aws: { region: 'eu-west-1' } } }; },
  async run() {
    const functions = [];
    for (let i = 0; i < ${count}; i++) functions.push(new sst.aws.Function('Report' + i, { handler: 'src/report-' + i + '.handler', runtime: 'nodejs24.x', architecture: 'x86_64', memory: '512 MB', timeout: '30 seconds', nodejs: { format: '${format}', minify: false, sourcemap: false, esbuild: { minifyIdentifiers: false, minifySyntax: true, minifyWhitespace: true, ${format === 'esm' ? `banner: { js: ${JSON.stringify(banner)} },` : ''} external: ['@aws-sdk/*'] } }, transform: { function: { tags: { 'benchmark-owner': process.env.BENCH_OWNER || 'local' } } } }));
    return { functions: functions.map(f => f.name) };
  }
});
`);
  console.log(root);
  return root;
};

if (process.argv[1] === new URL(import.meta.url).pathname) await generate(Number(process.argv[2] || 1), process.argv[3] || 'cjs');
