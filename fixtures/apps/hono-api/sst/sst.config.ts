/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'hono-api',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const api = new sst.aws.ApiGatewayV2('ApiGateway');
    api.route('$default', { handler: 'src/index.handler', memory: '512 MB' });

    return { url: api.url };
  }
});
