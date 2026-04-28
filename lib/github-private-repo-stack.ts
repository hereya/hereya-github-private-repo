import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export class HereyaGithubPrivateRepoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const projectName = required('projectName');
    const workspace = required('workspace');
    const deployWorkspace = process.env['deployWorkspace'] || '';

    const appId = required('hereyaGithubAppId');
    const installationId = required('hereyaGithubAppInstallationId');
    const privateKey = required('hereyaGithubAppPrivateKey');

    const sourceTemplate = required('sourceTemplate');
    const targetRepo = process.env['targetRepo'] || projectName;
    if (!sourceTemplate.includes('/')) {
      throw new Error(`sourceTemplate must be in "org/name" form, got "${sourceTemplate}"`);
    }
    if (!targetRepo.includes('/')) {
      throw new Error(`targetRepo (default: projectName) must be in "org/name" form, got "${targetRepo}"`);
    }

    const hereyaVarsJson = process.env['hereyaVarsJson'] || '{}';

    const safeName = projectName.replaceAll('/', '-');

    const privateKeySecret = new secretsmanager.Secret(this, 'GhAppPrivateKey', {
      secretName: `${safeName}/hereya-gh-app-private-key`,
      description: `GitHub App private key for ${projectName}`,
      secretStringValue: cdk.SecretValue.unsafePlainText(privateKey),
    });

    const handler = new NodejsFunction(this, 'GithubHandler', {
      entry: path.join(__dirname, 'github-handler', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      bundling: {
        nodeModules: ['@octokit/core', '@octokit/auth-app'],
      },
      environment: {
        GH_APP_ID: appId,
        GH_INSTALLATION_ID: installationId,
        GH_PRIVATE_KEY_SECRET_ARN: privateKeySecret.secretArn,
      },
    });
    privateKeySecret.grantRead(handler);

    const provider = new cr.Provider(this, 'GithubProvider', { onEventHandler: handler });

    new cdk.CustomResource(this, 'Repo', {
      serviceToken: provider.serviceToken,
      properties: {
        sourceTemplate,
        targetRepo,
        projectName,
        workspace,
        deployWorkspace,
        hereyaVarsJson,
      },
    });

    // hereyaGitPassword carries a "github-app:<installationId>" marker that the
    // hereya-cli credential helper recognises and exchanges for a fresh installation
    // token on every git operation. Stored in Secrets Manager because hereya init
    // prefixes outputs with the package's infra type ("aws:") and the AWS resolver
    // would otherwise try to fetch the marker as an ARN.
    const passwordMarkerSecret = new secretsmanager.Secret(this, 'GitPasswordMarker', {
      secretName: `${safeName}/hereya-git-password`,
      description: `Hereya git password marker for ${projectName}`,
      secretStringValue: cdk.SecretValue.unsafePlainText(`github-app:${installationId}`),
    });

    new cdk.CfnOutput(this, 'hereyaGitRemoteUrl', {
      value: `https://github.com/${targetRepo}.git`,
      description: 'GitHub HTTPS clone URL for the new private repo',
    });
    new cdk.CfnOutput(this, 'hereyaGitUsername', {
      value: 'x-access-token',
      description: 'Git HTTPS username for GitHub App installation token auth',
    });
    new cdk.CfnOutput(this, 'hereyaGitPassword', {
      value: passwordMarkerSecret.secretArn,
      description: 'ARN of the Secrets Manager secret carrying the github-app:<installationId> marker',
    });
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
