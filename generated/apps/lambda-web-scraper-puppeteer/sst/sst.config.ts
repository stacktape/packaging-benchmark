/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'lambda-web-scraper-puppeteer',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const api = new sst.aws.ApiGatewayV2('MainApiGateway');
    api.route('GET /scrape-links/{url}', {
      handler: 'src/scrape-links.default',
      memory: '1600 MB',
      timeout: '30 seconds',
      // @sparticuz/chromium ships a compressed browser that must stay a real node_modules package.
      nodejs: { install: ['@sparticuz/chromium'] }
    });

    return { url: api.url };
  }
});
