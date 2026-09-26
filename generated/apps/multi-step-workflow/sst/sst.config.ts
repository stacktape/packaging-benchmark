/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'multi-step-workflow',
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      protect: ['production'].includes(input?.stage),
      home: 'aws',
      providers: { aws: { region: 'eu-west-1' } }
    };
  },
  async run() {
    const sf = sst.aws.StepFunctions;
    const step = (name: string, handler: string) =>
      sf.lambdaInvoke({
        name,
        function: { handler },
        payload: '{% $states.input %}',
        output: '{% $states.result.Payload %}'
      });

    const failed = sf.fail({ name: 'Failed', error: 'WorkflowFailed', cause: 'One or more steps failed' });
    const validateInput = step('ValidateInput', 'src/validate-input.default').catch(failed);
    const processData = step('ProcessData', 'src/process-data.default')
      .retry({ errors: ['States.TaskFailed'], interval: '2 seconds', maxAttempts: 2, backoffRate: 2 })
      .catch(failed);
    const generateReport = step('GenerateReport', 'src/generate-report.default').catch(failed);
    processData.next(generateReport);

    const workflow = new sst.aws.StepFunctions('Workflow', {
      definition: validateInput.next(
        sf.choice({ name: 'IsValid' }).when('{% $states.input.valid %}', processData).otherwise(failed)
      )
    });

    const startWorkflow = new sst.aws.Function('StartWorkflow', {
      handler: 'src/start-workflow.default',
      memory: '512 MB',
      link: [workflow],
      environment: { STP_WORKFLOW_ARN: workflow.arn },
      // SST bundles the AWS SDK unless told otherwise; the Lambda runtime already has it.
      nodejs: { esbuild: { external: ['@aws-sdk/*'] } }
    });

    const api = new sst.aws.ApiGatewayV2('ApiGateway');
    api.route('POST /start', startWorkflow.arn);
    api.route('GET /status/{executionArn+}', startWorkflow.arn);

    return { url: api.url };
  }
});
