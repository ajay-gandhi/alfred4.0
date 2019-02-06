/**
 * Perform module
 *
 * This file contains the business logic for ordering through Seamless. The
 * do() function below will initialize the headless browser, order using the
 * orders module, and generate confirmations.
 */

const puppeteer = require("puppeteer");
const Orders = require("./orders");
const Users = require("./users");
const Stats = require("./stats");
const Transform = require("./util/transform");
const Slack = require("./util/slack");

const Logger = require("../util/logger");
const LOG = new Logger("alfred-order");

const private = require("./private");

// Setup
const URLS = {
  login: "https://www.seamless.com/corporate/login/",
  chooseTime: "https://www.seamless.com/meals.m",
};
const INITIAL_RETRIES = 2;

// Args
const ORDER_TIME = process.argv.reduce((m, a) => a.includes("--time=") ? a.substring(a.indexOf("=") + 1) : m, "5:30 PM");
const DRY_RUN = !process.argv.reduce((m, a) => m || a === "--actual", false);
const POST_TO_SLACK = process.argv.reduce((m, a) => m || a === "--post", false);

const go = async () => {
  // Initialize data and browser
  const orders = await Orders.getOrders();
  if (Object.keys(orders).length === 0) process.exit(0);

  const orderSets = Transform.indexByRestaurantAndUser(orders);

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium-browser",
    defaultViewport: {
      width: 1200,
      height: 900,
    },
  });
  const page = await browser.newPage();

  // Start ordering process
  const results = [];
  try {
    await loginToSeamless(page, private);
    LOG.log("Logged in");

    for (const orderSet of orderSets) {
      const orderResult = await orderFromRestaurant(page, orderSet.restaurant, orderSet.users, INITIAL_RETRIES);

      if (orderResult.errors) {
        results.push({
          successful: false,
          restaurant: orderSet.restaurant,
          users: orderSet.users,
          errors: orderResult.errors,
        });
      } else {
        results.push({
          successful: true,
          restaurant: orderSet.restaurant,
          userCall: orderResult.user.username,
          confirmationUrl: `https://alfred.ajay-gandhi.com/confirmations/${sanitizeFilename(orderSet.restaurant)}.pdf`,
        });

        // Record stats
        if (!DRY_RUN) {
          await Promise.all(orderSet.users.map(async (userOrder) => {
            const u = userOrder.username;
            const isCallee = orderResult.user.username === u;
            console.log(u, orderSet.restaurant, orderResult.orderAmounts[u], userOrder.items, isCallee);
            return Stats.recordStats(u, orderSet.restaurant, orderResult.orderAmounts[u], userOrder.items, isCallee);
          }));
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
    console.log(results);
  }

  if (!DRY_RUN) {
    const allSuccess = results.reduce((m, r) => m && r.successful, true);
  }
  await browser.close();
  process.exit(0);
};
setTimeout(go, 5000);

/**
 * Given a puppeteer page, logs into Seamless with the given credentials.
 */
const loginToSeamless = async (page, creds) => {
  await page.goto(URLS.login);

  await page.click("input#username");
  await page.keyboard.type(creds.username);

  await page.click("input#password");
  await page.keyboard.type(creds.password);

  await page.click("a#submitLogin");
  await page.waitForNavigation();
};

/**
 * Given a page with a logged-in status, this function will submit an order
 * at the given restaurant with the given items for the given usernames.
 */
const orderFromRestaurant = async (page, restaurant, userOrders, retries) => {
  try {
    let result = {};

    const usernames = userOrders.map(o => o.username);

    const steps = [
      chooseTime.bind(null, page),
      chooseRestaurant.bind(null, page, restaurant),
      fillOrders.bind(null, page, userOrders),
      fillNames.bind(null, page, usernames, result),
      fillPhoneNumber.bind(null, page, usernames),
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

/**
 * Given a page with a logged in status, chooses a time for ordering
 */
const chooseTime = async (page) => {
  try {
    await page.goto(URLS.chooseTime);
    await page.select("#time", ORDER_TIME).catch(() => {});
    await page.click("tr.startorder a");
    await page.waitForNavigation();
  } catch (e) {
    return {
      retry: e.toString().includes("Navigation Timeout Exceeded"),
      errors: [e.toString()],
    };
  }
};

/**
 * Given a page at the restaurant selection page, chooses the given restaurant
 */
const chooseRestaurant = async (page, restaurant) => {
  try {
    const restLinks = await page.$$("a[name=\"vendorLocation\"]");
    let ourRest;
    for (const anchor of restLinks) {
      const text = await page.evaluate(e => e.innerText, anchor);
      if (text.includes(restaurant)) ourRest = anchor;
    }
    await ourRest.click();
    await page.waitForNavigation();
  } catch (e) {
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
 *     username: "bobby",
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
      const totalBefore = await foodBevTotal(page);
      for (const [item, options] of userOrders[i].items) {
        // Click menu item
        const itemLinks = await page.$$("a[name=\"product\"]");
        let ourItem;
        for (const anchor of itemLinks) {
          const text = await page.evaluate(e => e.innerText.toLowerCase(), anchor);
          if (text.includes(item.toLowerCase())) ourItem = anchor;
        }
        await ourItem.click();
        await page.waitFor(1500);

        // Select options
        const optionLinks = await page.$$("li label");
        for (const opt of options) {
          for (const input of optionLinks) {
            const done = await page.evaluate((elm, opt) => {
              const isOpt = elm.innerText.toLowerCase().includes(opt.toLowerCase());
              if (isOpt) elm.click();
              return isOpt;
            }, input, opt);

            if (done) break;
          }
        }

        // Click add to order
        await page.$eval("a#a1", e => e.click());
        await page.waitFor(2000);
      }

      // Record for stats
      orderAmounts[userOrders[i].username] = (await foodBevTotal(page)) - totalBefore;
    }
  } catch (e) {
    // Most likely a timeout, or we didn't wait long enough
    return {
      retry: true,
      errors: [e.toString()],
    };
  }

  await page.waitFor(2000);

  const continueLinks = await page.$$("a.findfoodbutton");
  if (continueLinks.length === 0) {
    const userAts = Promise.all(orderAmounts.map(async o => Slack.atUser(o.username)));
    return {
      retry: false,
      errors: [`Delivery minimum not met. ${userAts.join(", ")}`],
    };
  }

  try {
    await page.$eval("a.findfoodbutton", e => e.click());
    await page.waitForNavigation();
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
 * usernames. The names parameter should be an array of tuples, where each
 * tuple contains the first and last names of all those involved in the order.
 */
const fillNames = async (page, usernames, { orderAmounts }) => {
  // Clear existing names first
  while (await page.$("td.delete a")) {
    await page.click("td.delete a");
    await page.waitForNavigation();
  }

  for (const username of usernames) {
    const name = (await Users.getUser(username)).name.split(" ");

    await page.evaluate(() => toggleAddUser(true, true));
    await page.waitFor(1000);
    await page.click("input#FirstName");
    await page.keyboard.type(name[0]);

    await page.click("input#LastName");
    await page.keyboard.type(name[1]);

    await page.click("tr#AddUser h4.PrimaryLink a");
    await page.waitForNavigation();
  }

  const amountAllocated = await page.$$eval("input.allocationAmt", i => i.map(e => Number(e.value)));
  if (Math.max.apply(null, amountAllocated) > 25) {
    // Exceeded budget
    const orderTotal = amountAllocated.reduce((m, a) => m + a, 0);
    const excess = (orderTotal - usernames.length * 25).toFixed(2);

    // Find person with most expensive order
    const maxOrder = Object.keys(orderAmounts).reduce((memo, username) => {
      if (orderAmounts[username] > memo.amount) {
        return {
          username,
          amount: orderAmounts[username],
        };
      } else {
        return memo;
      }
    }, { amount: 0 });
    const userAt = await Slack.atUser(maxOrder.username);

    return {
      retry: false,
      errors: [`Order exceeded budget by $${excess}. ${userAt}'s order is the highest at $${maxOrder.amount.toFixed(2)}.`],
    };
  }
};

/**
 * Given a page at the checkout page, fills out a random phone number.
 * Returns the user that was selected
 */
const fillPhoneNumber = async (page, usernames) => {
  try {
    const selectedUser = usernames[Math.floor(Math.random() * usernames.length)];
    const userData = await Users.getUser(selectedUser);
    await page.$eval("input#phoneNumber", e => e.value = "");
    await page.click("input#phoneNumber");
    await page.keyboard.type(userData.phone);
    await page.click("#ecoToGoTrue");
    return { user: userData };
  } catch (e) {
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
