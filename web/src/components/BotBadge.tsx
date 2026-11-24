import styles from "./BotBadge.module.css";

/** Marks the bot's seat. The bot is a normal player: it can decrypt only its own dice. */
export function BotBadge() {
  return (
    <span className={styles.badge} title="The bot is a normal player: it can decrypt only its own dice.">
      Bot
    </span>
  );
}
