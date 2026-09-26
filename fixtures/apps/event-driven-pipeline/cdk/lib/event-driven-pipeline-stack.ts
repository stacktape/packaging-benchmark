import * as cdk from 'aws-cdk-lib/core';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export class EventDrivenPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const orderDlq = new Queue(this, 'OrderDlq', { fifo: true });
    const orderQueue = new Queue(this, 'OrderQueue', {
      fifo: true,
      visibilityTimeout: cdk.Duration.seconds(30),
      deadLetterQueue: { queue: orderDlq, maxReceiveCount: 3 }
    });
    const eventBus = new EventBus(this, 'EventBus');

    const submitOrder = new NodejsFunction(this, 'SubmitOrder', {
      entry: 'src/submit-order.ts',
      handler: 'default',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512,
      environment: { STP_ORDER_QUEUE_URL: orderQueue.queueUrl }
    });
    orderQueue.grantSendMessages(submitOrder);

    const processOrder = new NodejsFunction(this, 'ProcessOrder', {
      entry: 'src/process-order.ts',
      handler: 'default',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: { STP_EVENT_BUS_ARN: eventBus.eventBusArn }
    });
    processOrder.addEventSource(new SqsEventSource(orderQueue, { batchSize: 1, reportBatchItemFailures: true }));
    eventBus.grantPutEventsTo(processOrder);

    const onOrderProcessed = new NodejsFunction(this, 'OnOrderProcessed', {
      entry: 'src/on-order-processed.ts',
      handler: 'default',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512
    });
    new Rule(this, 'OrderProcessedRule', {
      eventBus,
      eventPattern: { source: ['orders'], detailType: ['OrderProcessed'] },
      targets: [new LambdaFunction(onOrderProcessed)]
    });

    const httpApi = new HttpApi(this, 'HttpApi', {
      corsPreflight: { allowOrigins: ['*'], allowMethods: [CorsHttpMethod.ANY], allowHeaders: ['*'] }
    });
    httpApi.addRoutes({
      path: '/orders',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('SubmitOrderIntegration', submitOrder)
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
