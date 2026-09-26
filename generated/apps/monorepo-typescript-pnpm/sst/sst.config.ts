/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'monorepo-typescript-pnpm',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const api = new sst.aws.ApiGatewayV2('MyApiGateway');
    api.route('ANY /{proxy+}', { handler: 'packages/lambda/src/index.default' });

    return { url: api.url };
  }
});
