import * as cdk from 'aws-cdk-lib/core';
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export class LambdaApiDynamoDbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const postsTable = new TableV2(this, 'PostsTable', {
      partitionKey: { name: 'id', type: AttributeType.STRING }
    });

    const api = new NodejsFunction(this, 'Api', {
      entry: 'src/index.ts',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512,
      environment: { STP_POSTS_TABLE_NAME: postsTable.tableName }
    });
    postsTable.grantReadWriteData(api);

    const httpApi = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', api),
      corsPreflight: { allowOrigins: ['*'], allowMethods: [CorsHttpMethod.ANY], allowHeaders: ['*'] }
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
