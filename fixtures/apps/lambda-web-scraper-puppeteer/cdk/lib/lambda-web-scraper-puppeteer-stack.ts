import * as cdk from 'aws-cdk-lib/core';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class LambdaWebScraperPuppeteerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const scrapeLinks = new NodejsFunction(this, 'ScrapeLinks', {
      entry: 'src/scrape-links.ts',
      handler: 'default',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 1600,
      timeout: cdk.Duration.seconds(30),
      // @sparticuz/chromium ships a compressed browser that must stay a real node_modules package.
      bundling: { nodeModules: ['@sparticuz/chromium'] }
    });

    const httpApi = new HttpApi(this, 'MainApiGateway');
    httpApi.addRoutes({
      path: '/scrape-links/{url}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ScrapeLinksIntegration', scrapeLinks)
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
