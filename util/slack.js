/**
 * Module for sending messages to Slack
 */

const request = require("request");
const Users = require("../users");
const priv = require("../private");
const fs = require("fs");

const sendMessage = (text, attachments) => {
  return new Promise((resolve, reject) => {
    request({
      url: priv.slackOutgoingUrl,
      method: "POST",
      json: {
        text,
        attachments,
        channel: "#ot-test-ram",
      },
    }, (err, response, body) => {
      if (response.statusCode !== 200) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

module.exports.sendBasicMessage = sendMessage;

const atUser = async (username) => {
  const u = await Users.getUser(username);
  return u.slackId ? `<@${u.slackId}>` : `@${username}`;
}
module.exports.atUser = atUser;

// Formats the given stats
module.exports.statsFormatter = (stats) => {
  if (!stats.dollarStats && !stats.dishes) {
    return "```No stats```";
  }

  const dollarStats = `Total spent: $${stats.dollars.toFixed(2)}\n\n`;

  let callStats = "";
  if (stats.calls) {
    callStats = `Total calls received: ${stats.calls}\n\n`;
  }

  const dishStatsPrefix = "Top dishes:\n";
  const dishStats = stats.dishes.map((d) => {
    const rest = d.restaurant ? ` from ${d.restaurant}` : "";
    return `  ${d.count} of "${d.itemName}"${rest}`;
  }).join("\n");
  const otherMessage = Math.random() > 0.8 ? "\n\nWant other stats? Message Ajay!" : "";
  return `\`\`\`${dollarStats}${callStats}${dishStatsPrefix}${dishStats}${otherMessage}\`\`\``;
};

/**
 * Format of parts:
 *
 * [
 *   {
 *     successful: bool,
 *     restaurant: string,
 *     user: string,
 *     confirmationUrl: string,
 *   },
 *   ...
 * ],
 */
module.exports.sendFinishedMessage = async (parts, dry) => {
  if (dry) {
    const attachments = await Promise.all(parts.filter(p => !p.successful).map(async (part) => {
      const userAts = await Promise.all(part.users.map(u => atUser(u.username)));
      const text = part.errors.concat(`FYI: ${userAts.join(", ")}`).join("\n");
      return {
        color: "danger",
        title: part.restaurant,
        text,
      };
    }));

    // Don't send attachments if all restaurants will be successful
    if (attachments.length === 0) {
      await sendMessage("Everything looks good! I'll put in the order at 3:30pm.");
    } else {
      const succOrders = parts
        .filter(p => p.successful)
        .map(p => p.restaurant)
        .join(", ")
        .replace(/,(?!.*,)/gmi, " and");

      await sendMessage(
        (succOrders.length === 0 ? "" : `Orders from ${succOrders} are good to go!\n`) +
        `There are problems with ${attachments.length === 1 ? "this order" : "these orders"}:`,
        attachments
      );
    }
  } else {
    const attachments = await Promise.all(parts.map(async (part) => {
      const attachment = {
        color: part.successful ? "good" : "danger",
      };

      if (part.successful) {
        const slackAt = await atUser(part.userCall);
        attachment.title = part.restaurant;
        attachment.title_link = part.confirmationUrl;
        if (!dry) attachment.text = `${slackAt} will receive the call.`;
      } else {
        attachment.title = `${part.restaurant} (${dry ? "no order" : "failed"})`;
        attachment.text = part.errors.join("\n");
        const userAts = await Promise.all(part.users.map(u => atUser(u.username)));
        attachment.text += `\nFYI: ${userAts.join(", ")}`;
      }
      return attachment;
    }));

    const n = JSON.parse(fs.readFileSync(`${__dirname}/../private.json`, "utf8"));
    await sendMessage(
      "Alfred ordered from the following restaurants for delivery at 5:30pm.\n" +
      `Today's credentials are \`${n.confUsername}:${n.dailyPassword}\`.`,
      attachments
    );
  }
};
