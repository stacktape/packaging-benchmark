import * as cdk from 'aws-cdk-lib/core';
import { InstanceClass, InstanceSize, InstanceType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from 'aws-cdk-lib/aws-rds';
import { Nextjs } from 'cdk-nextjs-standalone';
import { Construct } from 'constructs';

export class FullstackNextjsDrizzleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'Vpc', { maxAzs: 2 });
    const database = new DatabaseInstance(this, 'Database', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_6 }),
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
      vpc,
      credentials: Credentials.fromGeneratedSecret('postgres'),
      databaseName: 'app'
    });
    const secret = database.secret!;
    const username = secret.secretValueFromJson('username').unsafeUnwrap();
    const password = secret.secretValueFromJson('password').unsafeUnwrap();

    const web = new Nextjs(this, 'Web', {
      nextjsPath: '.',
      environment: {
        STP_DATABASE_CONNECTION_STRING: `postgresql://${username}:${password}@${database.dbInstanceEndpointAddress}:${database.dbInstanceEndpointPort}/app`
      },
      overrides: { nextjsServer: { functionProps: { vpc } } }
    });
    database.connections.allowDefaultPortFrom(web.serverFunction.lambdaFunction);

    new cdk.CfnOutput(this, 'Url', { value: web.url });
  }
}
