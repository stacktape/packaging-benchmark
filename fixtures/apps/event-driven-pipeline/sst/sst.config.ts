/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'event-driven-pipeline',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    // SST bundles the AWS SDK unless told otherwise; the Lambda runtime already has it.
    const nodejs = { esbuild: { external: ['@aws-sdk/*'] } };

    const orderDlq = new sst.aws.Queue('OrderDlq', { fifo: true });
    const orderQueue = new sst.aws.Queue('OrderQueue', { fifo: true, dlq: orderDlq.arn });
    const eventBus = new sst.aws.Bus('EventBus');

    const api = new sst.aws.ApiGatewayV2('ApiGateway');
    api.route('POST /orders', {
      handler: 'src/submit-order.default',
      memory: '512 MB',
      link: [orderQueue],
      environment: { STP_ORDER_QUEUE_URL: orderQueue.url },
      nodejs
    });

    orderQueue.subscribe(
      {
        handler: 'src/process-order.default',
        memory: '512 MB',
        timeout: '30 seconds',
        link: [eventBus],
        environment: { STP_EVENT_BUS_ARN: eventBus.arn },
        nodejs
      },
      { batch: { size: 1, partialResponses: true } }
    );

    eventBus.subscribe(
      'OrderProcessed',
      { handler: 'src/on-order-processed.default', memory: '512 MB' },
      { pattern: { source: ['orders'], detailType: ['OrderProcessed'] } }
    );

    return { url: api.url };
  }
});
