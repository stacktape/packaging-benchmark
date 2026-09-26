import * as cdk from 'aws-cdk-lib/core';
import { CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Choice, Condition, DefinitionBody, Fail, StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export class MultiStepWorkflowStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const step = (name: string, entry: string) =>
      new NodejsFunction(this, name, { entry, handler: 'default', runtime: Runtime.NODEJS_24_X });
    const validateInput = step('ValidateInput', 'src/validate-input.ts');
    const processData = step('ProcessData', 'src/process-data.ts');
    const generateReport = step('GenerateReport', 'src/generate-report.ts');

    const failed = new Fail(this, 'Failed', { error: 'WorkflowFailed', cause: 'One or more steps failed' });
    const validate = new LambdaInvoke(this, 'Validate', { lambdaFunction: validateInput, payloadResponseOnly: true }).addCatch(failed);
    const process = new LambdaInvoke(this, 'Process', { lambdaFunction: processData, payloadResponseOnly: true })
      .addRetry({ errors: ['States.TaskFailed'], interval: cdk.Duration.seconds(2), maxAttempts: 2, backoffRate: 2 })
      .addCatch(failed);
    const report = new LambdaInvoke(this, 'Report', { lambdaFunction: generateReport, payloadResponseOnly: true }).addCatch(failed);

    const workflow = new StateMachine(this, 'Workflow', {
      comment: 'Multi-step data processing workflow',
      definitionBody: DefinitionBody.fromChainable(
        validate.next(
          new Choice(this, 'IsValid').when(Condition.booleanEquals('$.valid', true), process.next(report)).otherwise(failed)
        )
      )
    });

    const startWorkflow = new NodejsFunction(this, 'StartWorkflow', {
      entry: 'src/start-workflow.ts',
      handler: 'default',
      runtime: Runtime.NODEJS_24_X,
      memorySize: 512,
      environment: { STP_WORKFLOW_ARN: workflow.stateMachineArn }
    });
    workflow.grantStartExecution(startWorkflow);
    workflow.grantRead(startWorkflow);

    const httpApi = new HttpApi(this, 'HttpApi', {
      corsPreflight: { allowOrigins: ['*'], allowMethods: [CorsHttpMethod.ANY], allowHeaders: ['*'] }
    });
    const integration = new HttpLambdaIntegration('StartWorkflowIntegration', startWorkflow);
    httpApi.addRoutes({ path: '/start', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/status/{executionArn+}', methods: [HttpMethod.GET], integration });

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}
