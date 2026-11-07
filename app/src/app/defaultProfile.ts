import type { Profile } from '../contracts';

/**
 * The profile used until the toolkit profile is wired (src/toolkit). Values
 * are the PRD's defaults; participants change them on the day.
 */
export const DEFAULT_PROFILE: Profile = {
  routeProfile: 'shortest',
  speechRate: 1.1,
  verbosity: 'normal',
  directionStyle: 'landmarks',
  reassuranceEveryMeters: 200, // less chatter: Acuity answers "how far" on request
  earcons: true,
  haptics: true,
  usesScreenReader: false,
  maxAnswerWords: 25,
  trustedContact: null,
};
