/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'expressjs-api-postgres',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc('Vpc', { nat: 'managed' });
    const mainDatabase = new sst.aws.Postgres('MainDatabase', { vpc });

    const api = new sst.aws.ApiGatewayV2('ApiGateway');
    api.route('$default', {
      handler: 'src/index.handler',
      memory: '512 MB',
      vpc,
      link: [mainDatabase],
      environment: {
        STP_MAIN_DATABASE_CONNECTION_STRING: $interpolate`postgresql://${mainDatabase.username}:${mainDatabase.password}@${mainDatabase.host}:${mainDatabase.port}/${mainDatabase.database}`
      },
      // The generated Prisma client and its query engine, which esbuild cannot bundle.
      copyFiles: [{ from: 'node_modules/.prisma/client/' }]
    });

    return { url: api.url };
  }
});
