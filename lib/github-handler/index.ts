import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { Octokit } from '@octokit/core';
import { createAppAuth } from '@octokit/auth-app';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});

type Props = {
  sourceTemplate: string;
  targetRepo: string;
  projectName: string;
  workspace: string;
  deployWorkspace?: string;
  hereyaVarsJson?: string;
};

async function getPrivateKey(): Promise<string> {
  const arn = process.env.GH_PRIVATE_KEY_SECRET_ARN;
  if (!arn) throw new Error('GH_PRIVATE_KEY_SECRET_ARN env var not set');
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!resp.SecretString) throw new Error('Empty private key secret');
  return resp.SecretString;
}

function makeOctokit(privateKey: string): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GH_APP_ID,
      privateKey,
      installationId: process.env.GH_INSTALLATION_ID,
    },
  });
}

async function ensureRepo(octokit: Octokit, sourceTemplate: string, targetRepo: string): Promise<void> {
  const [tmplOwner, tmplRepo] = sourceTemplate.split('/');
  const [tgtOwner, tgtRepoName] = targetRepo.split('/');
  try {
    await octokit.request('POST /repos/{template_owner}/{template_repo}/generate', {
      template_owner: tmplOwner,
      template_repo: tmplRepo,
      owner: tgtOwner,
      name: tgtRepoName,
      private: true,
      include_all_branches: false,
    });
    console.log(`Created ${targetRepo} from template ${sourceTemplate}`);
  } catch (err: any) {
    if (err.status === 422) {
      console.log(`Repo ${targetRepo} already exists; will update files`);
      return;
    }
    if (err.status === 403 || err.status === 404) {
      throw new Error(`GitHub returned ${err.status} creating ${targetRepo} from ${sourceTemplate}. Verify the App has Administration:RW + Contents:RW on the target org and the source template is accessible. Original: ${err.message}`);
    }
    throw err;
  }
}

async function getOrNullFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    const resp = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path: filePath,
    });
    const data = resp.data as { content?: string; sha?: string };
    if (!data.content || !data.sha) return null;
    return {
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      sha: data.sha,
    };
  } catch (err: any) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function putFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  message: string,
  sha?: string,
): Promise<void> {
  await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    sha,
  });
}

async function readWithRetry(
  octokit: Octokit,
  owner: string,
  repo: string,
  filePath: string,
): Promise<{ content: string; sha: string } | null> {
  // GitHub may not have the file readable immediately after repo generation
  for (let i = 0; i < 3; i++) {
    const file = await getOrNullFile(octokit, owner, repo, filePath);
    if (file) return file;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function appendHereyaYaml(
  octokit: Octokit,
  targetRepo: string,
  projectName: string,
  workspace: string,
): Promise<void> {
  const [owner, repo] = targetRepo.split('/');
  const file = await readWithRetry(octokit, owner, repo, 'hereya.yaml');
  if (!file) {
    console.warn('hereya.yaml not found in target repo after retries; skipping append');
    return;
  }
  if (file.content.includes(`project: ${projectName}`) && file.content.includes(`workspace: ${workspace}`)) {
    return;
  }
  const updated = `${file.content.trimEnd()}\nproject: ${projectName}\nworkspace: ${workspace}\n`;
  await putFile(octokit, owner, repo, 'hereya.yaml', updated, 'hereya: set project and workspace', file.sha);
}

async function substituteClaudeMd(
  octokit: Octokit,
  targetRepo: string,
  deployWorkspace: string,
): Promise<void> {
  if (!deployWorkspace) return;
  const [owner, repo] = targetRepo.split('/');
  const file = await getOrNullFile(octokit, owner, repo, 'CLAUDE.md');
  if (!file) return;
  if (!file.content.includes('{{deployWorkspace}}')) return;
  const updated = file.content.replaceAll('{{deployWorkspace}}', deployWorkspace);
  await putFile(octokit, owner, repo, 'CLAUDE.md', updated, 'hereya: substitute deployWorkspace placeholder', file.sha);
}

async function writeHereyaVars(
  octokit: Octokit,
  targetRepo: string,
  hereyaVarsJson: string,
): Promise<void> {
  let vars: Record<string, unknown>;
  try {
    vars = JSON.parse(hereyaVarsJson || '{}');
  } catch {
    console.warn('hereyaVarsJson is not valid JSON; skipping');
    return;
  }
  if (!vars || typeof vars !== 'object') return;

  const [owner, repo] = targetRepo.split('/');
  for (const [filename, body] of Object.entries(vars)) {
    if (typeof body !== 'string') continue;
    const filePath = `hereyaconfig/hereyavars/${filename}`;
    const existing = await getOrNullFile(octokit, owner, repo, filePath);
    await putFile(octokit, owner, repo, filePath, body, `hereya: write ${filename}`, existing?.sha);
  }
}

export async function handler(event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> {
  console.log('RequestType:', event.RequestType);
  const props = (event.ResourceProperties as unknown) as Props;
  const { sourceTemplate, targetRepo, projectName, workspace, deployWorkspace = '', hereyaVarsJson = '{}' } = props;

  if (event.RequestType === 'Delete') {
    // Preserve user code: do not delete the GitHub repo.
    return { PhysicalResourceId: (event as { PhysicalResourceId?: string }).PhysicalResourceId || targetRepo };
  }

  const privateKey = await getPrivateKey();
  const octokit = makeOctokit(privateKey);

  if (event.RequestType === 'Create') {
    await ensureRepo(octokit, sourceTemplate, targetRepo);
  }

  await appendHereyaYaml(octokit, targetRepo, projectName, workspace);
  await substituteClaudeMd(octokit, targetRepo, deployWorkspace);
  await writeHereyaVars(octokit, targetRepo, hereyaVarsJson);

  return { PhysicalResourceId: targetRepo };
}
