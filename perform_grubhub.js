/**
 * Perform module
 *
 * This file contains the business logic for ordering through Seamless. The
 * do() function below will initialize the headless browser, order using the
 * orders module, and generate confirmations.
 */

const puppeteer = require("puppeteer");
const Orders = require("./models/orders");
const Users = require("./models/users");
const Stats = require("./models/stats");
const Transform = require("./util/transform");
const Slack = require("./util/slack");

// const Logger = require("../util/logger");
// const LOG = new Logger("alfred-order");
const LOG = { log: console.log };

const priv = require("./private");

// Setup
const URLS = {
  login: "https://www.grubhub.com/login",
  setupRest: "https://www.grubhub.com/lets-eat",
};
const INITIAL_RETRIES = 2;

// Args
const ORDER_TIME = process.argv.reduce((m, a) => a.includes("--time=") ? parseInt(a.substring(a.indexOf("=") + 1)) : m, 1730);
const DRY_RUN = !process.argv.reduce((m, a) => m || a === "--actual", false);
const POST_TO_SLACK = process.argv.reduce((m, a) => m || a === "--post", false);

const go = async () => {
  // Initialize data and browser
  const orders = await Orders.getOrders();
  if (Object.keys(orders).length === 0) process.exit(0);

  const orderSets = Transform.indexByRestaurantAndUser(orders);

  const browser = await puppeteer.launch({
    // executablePath: "/usr/bin/chromium-browser",
    headless: false,
    // defaultViewport: {
      // width: 1200,
      // height: 900,
    // },
  });
  const page = await browser.newPage();

  // Start ordering process
  const results = [];
  try {
    await loginToGrubhub(page);
    LOG.log("Logged in");

    for (const orderSet of orderSets) {
      const orderResult = await orderFromRestaurant(page, orderSet.restaurant, orderSet.users, INITIAL_RETRIES);
      const orderParticipants = orderSet.users.filter(u => !u.isDonor);

      if (orderResult.errors) {
        results.push({
          successful: false,
          restaurant: orderSet.restaurant,
          users: orderParticipants,
          errors: orderResult.errors,
        });
      } else {
        results.push({
          successful: true,
          restaurant: orderSet.restaurant,
          userCall: orderResult.user.slackId,
          confirmationUrl: `https://alfred.ajay-gandhi.com/confirmations/${sanitizeFilename(orderSet.restaurant)}.pdf`,
        });

        if (!DRY_RUN) {
          // Record stats
          await Promise.all(orderParticipants.map(async (userOrder) => {
            const slackId = userOrder.slackId;
            const isCallee = orderResult.user.slackId === slackId;
            return Stats.recordStats(slackId, orderSet.restaurant, orderResult.orderAmounts[slackId], userOrder.items, isCallee);
          }));

          // Write callee to orders
          await Orders.setCallee(orderResult.user.slackId);
        }
      }

      // Give seamless a break
      await page.waitFor(5000);
    }
  } catch (err) {
    LOG.log("Crashed with error", err);
  }

  if (POST_TO_SLACK) {
    await Slack.sendFinishedMessage(results, DRY_RUN);
  } else {
    LOG.log(results);
  }

  if (!DRY_RUN) {
    const allSuccess = results.reduce((m, r) => m && r.successful, true);
  }
  // await browser.close();
  process.exit(0);
};
setTimeout(go, 6000);

/**
 * Logs the given page into Grubhub
 */
const loginToGrubhub = async (page) => {
  await page.goto(URLS.login);

  await page.$eval("input[name=\"email\"]", (e, v) => e.value = v, priv.username);
  await page.$eval("input[name=\"password\"]", (e, v) => e.value = v, priv.password);

  await page.click("form.signInForm button");
  await page.waitForNavigation();
};

/**
 * Given a page with a logged-in status, this function will submit an order
 * at the given restaurant with the given items for the given slack IDs.
 */
const orderFromRestaurant = async (page, restaurant, userOrders, retries) => {
  try {
    let result = {};

    const slackIds = userOrders.map(o => o.slackId);

    const steps = [
      setupRestaurant.bind(null, page, restaurant),
      fillOrders.bind(null, page, userOrders),
      fillNames.bind(null, page, slackIds, result),
      fillPhoneNumber.bind(null, page, userOrders),
    ];

    // Here, we run each step one at a time. If a step fails and returns
    // retry: true, run the entire function again (up to INITIAL_RETRIES times)
    // If a step fails and with retry: false, return the error message
    // If a step has valuable output (only fillPhoneNumber() for now), save it
    // to result
    for (let step = 0; step < steps.length; step++) {
      const stepOutput = await steps[step]();
      if (stepOutput) {
        if (stepOutput.errors) {
          if (stepOutput.retry && retries > 0) {
            // Don't really care why, just retry
            return await orderFromRestaurant(page, restaurant, userOrders, retries - 1);
          } else {
            return stepOutput;
          }
        } else {
          result = Object.assign(result, stepOutput);
        }
      }
    }

    // Submit order
    const confirmationPath = `${__dirname}/confirmations/${sanitizeFilename(restaurant)}.pdf`;
    if (DRY_RUN) {
      await page.pdf({ path: confirmationPath });
      LOG.log(`Simulated order from ${restaurant}, confirmation is in ${confirmationPath}`);
    } else {
      await page.click("a.findfoodbutton");
      await page.waitForNavigation();
      await page.pdf({ path: confirmationPath });
      LOG.log(`Ordered from ${restaurant}, confirmation is in ${confirmationPath}`);
    }

    return result;
  } catch (e) {
    LOG.log(e);
    return {
      errors: ["Order failed for unknown reason."],
    };
  }
};

const setupRestaurant = async (page, restaurant) => {
  try {
    await page.goto(URLS.setupRest);
    await page.waitFor(1000);

    // Time
    await page.click("div.whenForSelector-btn");
    await page.waitFor("section.s-dialog-body");
    await page.waitFor(300);

    await page.select("section.s-dialog-body select", timeToString());
    await page.waitFor(500);
    await page.click("section.s-dialog-body button");
    await page.waitFor(500);

    // Restaurant
    await page.click("div.startOrder-search-input input");
    await page.waitFor(300);
    await page.click("div.navbar-menu-search input");
    await page.keyboard.type(restaurant);
    await page.waitFor("section.search-autocomplete-container div.searchAutocomplete-xsFixed");
    await page.click("div.ghs-autocompleteResult-container:first-child");

    // Wait for items to appear
    await page.waitFor(() => document.querySelectorAll("div.menuItem").length > 0);
    await page.waitFor(1000);
  } catch (e) {
    console.log(e);
    if (e instanceof TypeError) {
      // Couldn't find restaurant containing given text
      return {
        retry: false,
        errors: ["Restaurant does not exist or is closed at this time."],
      };
    } else {
      // Most likely a timeout, should retry
      return {
        retry: true,
        errors: [e.toString()],
      };
    }
  }
};

/**
 * Given a page at the order stage, this function will add the given orders to
 * the cart.
 *
 * The userOrders parameter should be an array of objects of this form:
 *   {
 *     slackId: "bobby",
 *     items: [
 *       [
 *         "dish1",
 *         ["option 1", "option 2"],
 *       ],
 *       [
 *         "dish2",
 *         ["option 1", "option 2"],
 *       ],
 *     ]
 *   }
 */
const fillOrders = async (page, userOrders) => {
  const orderAmounts = {};
  try {
    for (let i = 0; i < userOrders.length; i++) {
      // const totalBefore = await foodBevTotal(page);
      for (const [item, options] of userOrders[i].items) {
        // Click menu item
        const itemLinks = await page.$$("h6.menuItem-name a");
        let ourItem;
        for (const anchor of itemLinks) {
          const text = await page.evaluate(e => e.innerText.trim(), anchor);
          if (text === item) {
            anchor.click();
            break;
          }
        }
        await page.waitFor("div.s-dialog-body");
        await page.waitFor(200);

        // Select options
        const optionLinks = await page.$$("span.menuItemModal-choice-option-description");
        for (const opt of options) {
          for (const input of optionLinks) {
            const optionText = await page.evaluate(e => e.innerText, input);
            if (Transform.simplifyOption(optionText) === opt) {
              await page.evaluate(e => e.click(), input);
              break;
            }
          }
        }

        // Click add to order
        await page.click("button.menuItemModal-btnSubmit");
        await page.waitFor(() => !document.querySelector("div.s-dialog-body"));
        await page.waitFor(1000);
      }

      // Record for stats
      // orderAmounts[userOrders[i].slackId] = (await foodBevTotal(page)) - totalBefore;
    }
  } catch (e) {
    console.log(e);
    // Most likely a timeout, or we didn't wait long enough
    return {
      retry: true,
      errors: [e.toString()],
    };
  }

  const minimumMet = await page.$eval("button#ghs-cart-checkout-button", e => !e.disabled);
  if (!minimumMet) {
    return {
      retry: false,
      errors: ["Delivery minimum not met."],
    };
  }

  try {
    await page.click("button#ghs-cart-checkout-button");
    await page.waitForNavigation();
    // await page.waitFor(3000);
    return { orderAmounts };
  } catch (e) {
    // Most likely a timeout
    return {
      retry: true,
      errors: [e.toString()],
    };
  }
};

/**
 * Given a page at the checkout stage, this function will enter the given
 * names. The names parameter should be an array of tuples, where each tuple
 * contains the first and last names of all those involved in the order.
 */
const fillNames = async (page, slackIds, { orderAmounts }) => {
  // Enable split with coworkers
  await page.waitFor("label[for=\"showAllocations\"]");
  await page.click("label[for=\"showAllocations\"]");
  await page.waitFor(200);

  for (const slackId of slackIds) {
    const name = (await Users.getUser(slackId)).name;
    if (name.toLowerCase() === "ajay gandhi") continue;

    await page.click("div.allocations-fields-container > div > input");
    await page.keyboard.type(name);

    await page.waitFor(3000);
    await page.click("div.allocations-autocomplete-dropdown div.s-row");
    await page.waitFor(5000);
  }

  // Clear my allocation
  await page.click("div.allocations-fields-container table tr:last-of-type td.u-text-right button");
  const myAllocation = await page.$("div.allocations-fields-container table tr:last-of-type td.u-text-secondary input");
  await myAllocation.click({ clickCount: 3 });
  await myAllocation.type("0");
  await page.click("div.allocations-fields-container table tr:last-of-type td.u-text-right button");
  await page.waitFor(2000);

  const amountAllocated = await page.$$eval("div.allocation-saved-cell", i => i.map(e => Number(e.innerText.trim().substring(1))));
  if (Math.max.apply(null, amountAllocated) > 25) {
    // Exceeded budget
    const orderTotal = amountAllocated.reduce((m, a) => m + a, 0);
    const excess = (orderTotal - slackIds.length * 25).toFixed(2);

    // Find person with most expensive order
    const maxOrder = Object.keys(orderAmounts).reduce((memo, slackId) => {
      if (orderAmounts[slackId] > memo.amount) {
        return {
          slackId,
          amount: orderAmounts[slackId],
        };
      } else {
        return memo;
      }
    }, { amount: 0 });

    return {
      retry: false,
      errors: [`Order exceeded budget by $${excess}. ${Slack.atUser(maxOrder.slackId)}'s order is the highest at $${maxOrder.amount.toFixed(2)}.`],
    };
  }
};

/**
 * Given a page at the checkout page, fills out a random phone number.
 * Returns the user that was selected
 */
const fillPhoneNumber = async (page, orders) => {
  try {
    const slackIds = orders.reduce((memo, o) => o.isDonor ? memo : memo.concat(o.slackId), []);
    const selectedUser = slackIds[Math.floor(Math.random() * slackIds.length)];
    const user = await Users.getUser(selectedUser);

    const shouldClick = await page.$eval("div[at-delivery-instructions-toggle=\"true\"] use", e => e.getAttribute("href"));
    if (shouldClick === "#plus") await page.click("div[at-delivery-instructions-toggle=\"true\"]");
    const whoYaGonnaCall = await page.$("textarea#specialInstructions");
    await whoYaGonnaCall.click({ clickCount: 3 });
    await page.keyboard.type(`Please call ${user.name} at ${user.phone} upon delivery / arrival`);

    // Eco-friendly order!
    await page.click("label[for=\"ghs-checkout-green\"]");

    return { user };
  } catch (e) {
    console.log(e);
    // Most likely a timeout
    return {
      retry: true,
      errors: [e.toString()],
    };
  }
};

/********************************** Helpers ***********************************/

/**
 * Converts a restaurant name to one that's nice for the FS
 */
const NOT_ALPHAN_REGEX = /[\W_]+/g;
const sanitizeFilename = n => n.replace(NOT_ALPHAN_REGEX, "_").replace(/^_+|_+$/g, "").toLowerCase();

/**
 * Given a page at the add items stage, returns the current food/beverages total
 */
const totalSelector = "div#OrderTotals table tbody tr:not(.noline):not(.subtotal) td:not(.main)";
const foodBevTotal = async (page) => {
  const textTotal = await page.$eval(totalSelector, e => e.innerText);
  return parseFloat(textTotal.substring(1));
}

const timeToString = () => {
  const now = new Date();
  now.setHours(Math.floor(ORDER_TIME / 100), ORDER_TIME % 100, 0, 0);
  return now.toISOString();
};