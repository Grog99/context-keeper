import { Command, CommandRunner } from 'nest-commander';
import { ProjectsService } from '../projects/projects.service';
import { printTokenReveal } from './print';

/**
 * Graceful rotation (roadmap v1.3, "Wiele tokenów per projekt + graceful rotation") — argument jest
 * teraz TOKEN id, nie project id (rotacja jest token-scoped, §Approach planu: N tokenów per projekt,
 * project id jest niejednoznaczny). Znajdź `<tokenId>` przez `list-tokens <projectId>` najpierw.
 */
@Command({
  name: 'rotate-token',
  arguments: '<tokenId>',
  description: 'Rotuje token (graceful — stary działa jeszcze przez TOKEN_GRACE_PERIOD_HOURS). Id z: list-tokens <projectId>.',
})
export class RotateTokenCommand extends CommandRunner {
  constructor(private readonly projects: ProjectsService) {
    super();
  }

  async run(inputs: string[]): Promise<void> {
    const tokenId = inputs[0]?.trim();
    if (!tokenId) {
      throw new Error('Podaj id tokena: rotate-token <tokenId> (patrz: list-tokens <projectId>)');
    }
    const { tokenRow, previousTokenRow, token } = await this.projects.rotateToken(tokenId);
    const project = await this.projects.findById(tokenRow.projectId);
    if (!project) {
      throw new Error(`Projekt nie istnieje: ${tokenRow.projectId}`);
    }
    printTokenReveal(project, token, 'zrotowany', tokenRow.label, previousTokenRow.expiresAt ?? undefined);
  }
}
