export const PLAYER_SEARCH_DEBOUNCE_MS = 400;
export const PLAYER_SEARCH_MIN_CHARACTERS = 3;

export function canSearchPlayer(gameName: string, tagLine: string) {
  return (
    gameName.trim().length >= PLAYER_SEARCH_MIN_CHARACTERS
    || tagLine.trim().length >= PLAYER_SEARCH_MIN_CHARACTERS
  );
}
