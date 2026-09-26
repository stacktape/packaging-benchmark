/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'fullstack-nextjs-drizzle',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc('Vpc', { nat: 'managed' });
    const database = new sst.aws.Postgres('Database', { vpc });

    const web = new sst.aws.Nextjs('Web', {
      vpc,
      link: [database],
      environment: {
        STP_DATABASE_CONNECTION_STRING: $interpolate`postgresql://${database.username}:${database.password}@${database.host}:${database.port}/${database.database}`
      }
    });

    return { url: web.url };
  }
});
