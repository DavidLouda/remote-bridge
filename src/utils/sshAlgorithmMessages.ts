import * as vscode from 'vscode';
import { AlgorithmProblem, OPENSSH_ALGORITHM_KEYWORDS } from './sshAlgorithms';

/** Localized, single-line description of SSH algorithm setting problems. */
export function formatAlgorithmProblems(problems: readonly AlgorithmProblem[]): string {
    const details = problems.map((problem) => {
        const keyword = OPENSSH_ALGORITHM_KEYWORDS[problem.category];
        switch (problem.kind) {
            case 'syntax':
                return vscode.l10n.t('{0}: invalid algorithm list "{1}"', keyword, problem.value);
            case 'unsupported':
                return vscode.l10n.t('{0}: unsupported algorithm(s): {1}', keyword, problem.names.join(', '));
            case 'empty':
                return vscode.l10n.t('{0}: no algorithm would be left to use', keyword);
        }
    });
    return vscode.l10n.t('Invalid SSH algorithm settings — {0}', details.join('; '));
}
