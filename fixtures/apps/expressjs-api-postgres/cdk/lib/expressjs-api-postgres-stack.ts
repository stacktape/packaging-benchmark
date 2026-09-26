import * as cdk from 'aws-cdk-lib/core';
import { CorsHttpMethod, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { InstanceClass, InstanceSize, InstanceType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export class ExpressjsApiPostgresStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', { maxAzs: 2 });
    const mainDatabase = new DatabaseInstance(this, 'MainDatabase', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_18_1 }),
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      vpc,
      credentials: Credentials.fromGeneratedSecret('postgres'),
      databaseName: 'app'
    });
    const secret = mainDatabase.secret!;
    const username = secret.secretValueFromJson('username').unsafeUnwrap();
    const password = secret.secretValueFromJson('password').unsafeUnwrap();

    const api = new NodejsFunction(this, 'Api', {
      entry: 'src/index.ts',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512,
      vpc,
      environment: {
        STP_MAIN_DATABASE_CONNECTION_STRING: `postgresql://${username}:${password}@${mainDatabase.dbInstanceEndpointAddress}:${mainDatabase.dbInstanceEndpointPort}/app`
      },
      // Prisma's query engine is a native library esbuild cannot bundle: install the client into the asset and
      // generate it there for Lambda's Linux.
      bundling: {
        nodeModules: ['@prisma/client', 'prisma'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: (inputDir, outputDir) => [`cp -r ${inputDir}/prisma ${outputDir}`],
          afterBundling: (_inputDir, outputDir) => [
            `cd ${outputDir} && npx prisma generate && rm -rf node_modules/@prisma/engines`
          ]
        }
      }
    });
    mainDatabase.connections.allowDefaultPortFrom(api);

    const httpApi = new HttpApi(this, 'HttpApi', {
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', api),
      corsPreflight: { allowOrigins: ['*'], allowMethods: [CorsHttpMethod.ANY], allowHeaders: ['*'] }
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
