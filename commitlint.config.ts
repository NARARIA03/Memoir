import { RuleConfigSeverity, type UserConfig } from '@commitlint/types';

const commitlintConfig: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: { 'subject-contains-issue': [RuleConfigSeverity.Error, 'always'] },
  plugins: [
    {
      rules: {
        'subject-contains-issue': (parsed) => {
          const subject = parsed.subject ?? '';
          const issueNumberRegex = /\(#\d+\)/;
          const isValid = issueNumberRegex.test(subject);
          return [isValid, '커밋 subject에 (#123) 형식의 이슈 번호를 포함해야 합니다.'];
        },
      },
    },
  ],
};

export default commitlintConfig;
