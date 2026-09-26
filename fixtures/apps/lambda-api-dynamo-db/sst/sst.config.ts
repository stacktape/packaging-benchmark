/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'lambda-api-dynamo-db',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const postsTable = new sst.aws.Dynamo('PostsTable', {
      fields: { id: 'string' },
      primaryIndex: { hashKey: 'id' }
    });

    const api = new sst.aws.ApiGatewayV2('ApiGateway');
    api.route('$default', {
      handler: 'src/index.handler',
      memory: '512 MB',
      link: [postsTable],
      environment: { STP_POSTS_TABLE_NAME: postsTable.name },
      // SST bundles the AWS SDK unless told otherwise; the Lambda runtime already has it.
      nodejs: { esbuild: { external: ['@aws-sdk/*'] } }
    });

    return { url: api.url };
  }
});
