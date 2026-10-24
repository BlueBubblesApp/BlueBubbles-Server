/**
 * Whether Messages filed this chat under Spam, derived from the chat's decoded
 * `properties` plist. `SMSCategory` 1 is the Spam list; `wasDetectedAsSMSSpam`
 * marks chats Messages flagged on its own. `chat.is_filtered` is not used: it
 * is also set on chats that sit in the main list.
 */
export function isChatFilteredAsSpam(properties: NodeJS.Dict<any>[] | null | undefined): boolean {
    if (!Array.isArray(properties)) return false;
    return properties.some(
        props =>
            props != null &&
            typeof props === "object" &&
            (props.SMSCategory === 1 || props.wasDetectedAsSMSSpam === true)
    );
}
