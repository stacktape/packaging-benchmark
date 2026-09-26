import * as cdk from 'aws-cdk-lib/core';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class MonorepoTypescriptPnpmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const myLambda = new NodejsFunction(this, 'MyLambda', {
      entry: 'packages/lambda/src/index.ts',
      handler: 'default',
      runtime: Runtime.NODEJS_24_X,
      depsLockFilePath: 'pnpm-lock.yaml'
    });

    const httpApi = new HttpApi(this, 'MyApiGateway');
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration('MyLambdaIntegration', myLambda)
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
