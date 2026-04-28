#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HereyaGithubPrivateRepoStack } from '../lib/github-private-repo-stack';

const app = new cdk.App();
new HereyaGithubPrivateRepoStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
