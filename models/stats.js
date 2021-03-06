/**
 * Module for interacting with persistent stats data
 */

const MongoClient = require("mongodb").MongoClient;
const logger = require("../logger")("model");
const priv = require("../private");

let stats;
const client = new MongoClient(priv.mongoSrv, { useNewUrlParser: true });
client.connect((err) => {
  if (err) logger.error(err);
  stats = client.db(priv.mongoDbName).collection("stats");
});

const N_TOP_DISHES = 3;

/********************************** Helpers ***********************************/

/**
 * Return how many times the given user has been called
 */
const getCallsForUser = async (slackId) => {
  const s = await stats.findOne({ slackId });
  return s ? s.calls : 0;
};

/**
 * Return the dollar value that the user spent at this restaurant
 */
const getDollarsForRestaurant = async (slackId, restaurantName) => {
  const s = await stats.findOne({ slackId });
  return s && s.restaurants[restaurantName].dollars;
};

/**
 * Return the dollar value that the user spent
 */
const getDollarsForUser = async (slackId) => {
  const s = await stats.findOne({ slackId });
  return s && Object.keys(s.restaurants).reduce((m, r) => m + s.restaurants[r].dollars, 0);
};

/**
 * Return the dollar value that all users spent
 */
const getTotalDollars = async () => {
  const allStats = await stats.find({}).toArray();
  return allStats.reduce((total, s) => {
    return total + Object.keys(s.restaurants).reduce((m, r) => m + s.restaurants[r].dollars, 0);
  }, 0);
};

/**
 * Return the top dishes for this user at this restaurant
 */
const getTopDishesForRestaurant = async (slackId, restaurant) => {
  const pulled = await stats.findOne({ slackId });
  if (!pulled) return;

  const s = fromMongo(pulled.restaurants[restaurant].items);
  return Object.keys(s).reduce((tops, itemName) => {
    for (let i = 0; i < N_TOP_DISHES; i++) {
      if (!tops[i] || s[itemName] > tops[i].count) {
        tops.splice(i, 0, {
          itemName,
          count: s[itemName],
        });
        if (tops.length > N_TOP_DISHES) tops.pop();
        break;
      }
    }
    return tops;
  }, []);
};

/**
 * Return the top dishes for this user
 */
const getTopDishesForUser = async (slackId) => {
  const pulled = await stats.findOne({ slackId });
  if (!pulled) return;

  const s = fromMongo(pulled.restaurants);
  return Object.keys(s).reduce((userTops, restaurant) => {
    return Object.keys(s[restaurant].items).reduce((restTops, itemName) => {
      for (let i = 0; i < N_TOP_DISHES; i++) {
        if (!restTops[i] || s[restaurant].items[itemName] > restTops[i].count) {
          restTops.splice(i, 0, {
            itemName,
            count: s[restaurant].items[itemName],
            restaurant,
          });
          if (restTops.length > N_TOP_DISHES) restTops.pop();
          break;
        }
      }
      return restTops;
    }, userTops);
  }, []);
};

/**
 * Return the top dishes for all users
 */
const getTopDishes = async () => {
  const allStats = fromMongo(await stats.find({}).toArray());

  // First create array of all restaurant data (removes user association)
  const restaurantData = allStats.reduce((memo, userStats) => {
    const restDataAsList = Object.keys(userStats.restaurants).map((restaurantName) => {
      return {
        name: restaurantName,
        items: userStats.restaurants[restaurantName].items,
      };
    });
    return memo.concat(restDataAsList);
  }, []);

  // Consolidate restaurant data into single object
  const crd = restaurantData.reduce((memo, data) => {
    if (!memo[data.name]) memo[data.name] = {};

    Object.keys(data.items).forEach((itemName) => {
      if (!memo[data.name][itemName]) memo[data.name][itemName] = 0;
      memo[data.name][itemName] += data.items[itemName];
    });
    return memo;
  }, {});

  // Given consolidated restaurant data find tops
  // Basically same logic as getTopDishesForUser
  return Object.keys(crd).reduce((allTops, restaurant) => {
    return Object.keys(crd[restaurant]).reduce((restTops, itemName) => {
      for (let i = 0; i < N_TOP_DISHES; i++) {
        if (!restTops[i] || crd[restaurant][itemName] > restTops[i].count) {
          restTops.splice(i, 0, {
            itemName,
            count: crd[restaurant][itemName],
            restaurant,
          });
          if (restTops.length > N_TOP_DISHES) restTops.pop();
          break;
        }
      }
      return restTops;
    }, allTops);
  }, []);
};

/********************************** Exports ***********************************/

// The following functions consolidate data from above helpers
const getStatsForUserFromRestaurant = async (user, restaurant) => ({
  dollars: await getDollarsForRestaurant(user, restaurant),
  dishes: await getTopDishesForRestaurant(user, restaurant),
});
const getStatsForUser = async (user) => ({
  calls: await getCallsForUser(user),
  dollars: await getDollarsForUser(user),
  dishes: await getTopDishesForUser(user),
});
const getGlobalStats = async () => ({
  dollars: await getTotalDollars(),
  dishes: await getTopDishes(),
});

/**
 * Record the given set of stats
 */
const recordStats = async (slackId, restaurant, dollars, items, calls) => {
  const changes = items.reduce((memo, [itemName]) => {
    const key = `restaurants.${restaurant}.items.${toMongo(itemName)}`;
    memo[key] = memo[key] ? memo[key] + 1 : 1;
    return memo;
  }, {});

  changes[`restaurants.${restaurant}.dollars`] = dollars;
  if (calls) changes["calls"] = 1;

  await stats.findOneAndUpdate({ slackId }, { $inc: changes }, { upsert: true });
};

module.exports = {
  getStatsForUserFromRestaurant,
  getStatsForUser,
  getGlobalStats,
  recordStats,
};

/********************************* Sanitizers *********************************/

// These functions sanitize data so that it can safely be passed to Mongo
const toMongo = s => s.replace(".", "%PD%");
const fromMongo = (o) => {
  if (typeof o !== "object") return o;

  if (o instanceof Array) {
    return o.map(fromMongo);
  } else {
    return Object.keys(o).reduce((memo, key) => {
      memo[key.replace("%PD%", ".")] = fromMongo(o[key]);
      return memo;
    }, {});
  }
};
