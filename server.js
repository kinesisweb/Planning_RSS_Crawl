// Package dependencies
const express = require("express"),
	exphbs = require("express-handlebars"),
	app = express(),
	path = require("path"),
	fs = require("fs"),
	request = require("request"),
	jsdom = require("jsdom"),
	Nightmare = require("nightmare"),
	nightmare = Nightmare({ show: true, waitTimeout: 8000 });

// Local json files
const settings = require("./rsssettings.json");
const cache = require("./rsscache.json");

// Declaring needed variables
let promises = [];
const dir = path.join(__dirname, "public");
const image = settings.RSSImage;
image.url =
	"http://" + settings.domain + ":" + settings.port + settings.RSSImage.url;

console.log("Running RSS");

// Set Handlebars views and templates
app.use(function(req, res, next) {
	res.locals.view = {
		layoutsDir: "views/layouts",
		defaultLayout: "xml",
		partialsDir: "views/partials",
		viewsDir: "views"
	};
	setTemplates(req, res);
	next();
});

// Declare needed response variables and check if scraping has taken place in x minutes
app.get("/xmlfeed", function(req, res) {
	res.locals.fullurl = req.protocol + "://" + req.get("host") + req.originalUrl;
	res.locals.newrss = {};
	res.locals.newrss.rssitems = [];
	checkCache(req, res);
});

// Return requests for static resources and listen for future requests
app.use(express.static(dir));
app.listen(settings.port);

// FUNCTIONS

// If feed is being accessed before buffer ends, serve the cached feed, if not, update the feed
function checkCache(req, res) {
	const ctime = new Date().getTime();
	const lasttime = parseInt(cache.lastCache) || 0;
	const diff = 1000 * 60 * parseInt(settings.RSSttl);

	if (lasttime + diff > ctime) returnFeed(req, res);
	else updateCache(req, res, refreshFeed);
}

// Render the rss feed
function returnFeed(req, res, newcache) {
	let rssitems;
	if (newcache) rssitems = newcache.rssitems;
	else rssitems = cache.rssitems;

	const date = new Date();
	const d = mySqlDatetime(date);
	console.log("Replying to RSS feed request @ " + d);
	res.header("Content-Type", "text/xml");
	res.render("xmlitems", {
		fullurl: res.locals.fullurl,
		title: settings.RSSTitle,
		ttl: settings.RSSttl,
		image: image,
		link: settings.RSSLink,
		description: settings.RSSDescription,
		rssitems: rssitems
	});
}

function setTemplates(req, res) {
	app.engine(
		".handlebars",
		exphbs({
			defaultLayout: res.locals.view.defaultLayout,
			extname: ".handlebars",
			layoutsDir: res.locals.view.layoutsDir,
			partialsDir: res.locals.view.partialsDir,
			helpers: res.locals.view.helpers
		})
	);
	app.set("view engine", ".handlebars");
	app.set("views", res.locals.view.viewsDir);
}

// Date and time in MySQL format with no single-digit values
function mySqlDatetime(data) {
	const c = data ? new Date(data) : new Date();
	const datetime = `${c.getFullYear()}-${
		c.getMonth() + 1 < 10 ? "0" + (c.getMonth() + 1) : c.getMonth() + 1
	}-${c.getDate() < 10 ? "0" + c.getDate() : c.getDate()} ${
		c.getHours() < 10 ? "0" + c.getHours() : c.getHours()
	}:${c.getMinutes() < 10 ? "0" + c.getMinutes() : c.getMinutes()}:${
		c.getSeconds() < 10 ? "0" + c.getSeconds() : c.getSeconds()
	}`;
	return datetime;
}

// Navigate the target website, scrape all data and set promises to call the Documents page for every search hit
function updateCache(req, res, cb) {
	// refreshFeed is cb

	let search_hits = 0;
	nightmare
		.useragent(settings.userAgent)
		.goto(settings.searchUrl)
		.wait("input.button.primary")
		.click("input.button.primary")
		.wait("#searchresults")
		.evaluate(function() {
			// Check how many results we can expect from the initial 10 default ones served
			let multiple = false;
			if (document.querySelector(".pager")) {
				multiple = true;
			}

			const initial_hits = document.querySelectorAll(".searchresult");
			var hits = initial_hits.length;

			if (hits == 10 && multiple === false) return 10;
			else if (hits == 10 && multiple === true) return 11;
			else return hits;
		})
		.then(function(hits) {
			search_hits = hits;
		})
		.then(function() {
			console.log(search_hits);
			return nightmare
				.select("#resultsPerPage", "100")
				.click("input.button.primary")
				.wait(".searchresult:nth-child(" + search_hits + ")")
				.evaluate(function() {
					let searchResults = [];
					const results = document.querySelectorAll(".searchresult");
					results.forEach(function(result) {
						const results_link = result.querySelector("a");
						const results_add = result.querySelector(".address");
						const results_meta = result.querySelector(".metaInfo");
						const meta_in = results_meta.innerHTML;
						const msa = meta_in.split('<span class="divider">|</span>') || null;
						const ref = msa[0].split(":")[1] || null;
						const val = msa[1].split(":")[1] || null;
						const stat = msa[2].split(":")[1] || null;
						let href = results_link.href;
						href = href.replace("summary", "documents");
						const row = {
							title: results_link.innerText,
							address: results_add.innerText,
							url: href,
							ref: ref,
							validated: val,
							status: stat
						};
						searchResults.push(row);
					});
					return searchResults; // Pass all hits from the search page to our custom search filtering
				});
		})
		.then(function(result) {
			result.forEach(function(r) {
				const ss = settings.searchTerms;
				let match = false;

				for (let i of ss) {
					// Search the title string of each result for search terms in settings file
					if (r.title.toLowerCase().search(i.toLowerCase()) >= 0) match = true;
				}

				// Add the request for the Document/Application Form address to the promise array
				if (match === true) promises.push(addItem(req, res, r));
			});

			Promise.all(promises)
				.then(function() {
					// Wait until all documents are returned before updating the cache file
					writeCache(req, res, cb);
				})
				.catch(function(e) {
					console.log(
						"Unable to update cache – Promises Failed\n--------------------------\n" +
							e
					);
					returnFeed(req, res);
				});
			return nightmare.end();
		})
		.then(function() {
			console.log("Nightmare Complete");
		})
		.catch(function(e) {
			console.log(
				"Unable to update cache – Nightmare Failed\n--------------------------\n" +
					e
			);
			returnFeed(req, res);
		});
}

function addItem(req, res, item) {
	// Return a promise for each search item to find its Application Form

	return new Promise((resolve, reject) => {
		const fetch = request(item.url, function(err, response, body) {
			if (err) {
				console.log(err);
				reject(err);
			}

			jsdom.env({
				html: body,
				scripts: ["http://code.jquery.com/jquery-1.6.min.js"],
				done: function(err, window) {
					//Use jQuery just as in a regular HTML page
					var $ = window.jQuery,
						tableRow = "";

					if ($("table#documents")) {
						tableRow = $("td")
							.filter(function() {
								return $(this).text() == "Application Form";
							})
							.closest("tr");
					} else {
						tableRow = null;
					}

					// Removed var appForm = $(tableRow).find('a').attr("href"); from first if below
					if (
						$(tableRow)
							.find("a")
							.attr("href")
					) {
						var app_ex = true;
						var appForm = item.url;
					} else {
						var appForm = item.url.replace("documents", "summary");
						var app_ex = false;
					}

					if (appForm.substring(0, 1) == "/") {
						appForm = settings.root + appForm;
					}

					var description =
						"<p><b>Address</b>: " +
						item.address.replace(/\s\s+/g, " ") +
						"</p><p><b>Status</b>: " +
						item.status.replace(/\s\s+/g, " ") +
						"</p><p><b>Ref</b>: " +
						item.ref.replace(/\s\s+/g, " ") +
						"</p><p><b>Validated</b>: " +
						item.validated.replace(/\s\s+/g, " ") +
						"</p><p>For full details on this application, see the <a href='" +
						item.url.replace("documents", "summary") +
						"'>Cornwall Council planning page</a>.";
					if (app_ex) {
						description += "</p>";
					} else {
						description +=
							" There is currently no Application Form available for this case.</p>";
					}
					var hash = require("crypto")
						.createHash("md5")
						.update(item.title)
						.digest("hex");
					var newitem = {
						link: appForm,
						title: item.title,
						description: description,
						guid: hash
					};
					res.locals.newrss.rssitems.push(newitem);
					resolve("Item Added");
				}
			});
		});
	});
}

// Update rsscache.json with new search result and set new lastCache time
function writeCache(req, res, cb) {
	// refreshFeed is cb
	var ctime = new Date().getTime();
	res.locals.newrss.lastCache = ctime;
	var json = JSON.stringify(res.locals.newrss, null, 2);
	var logdate = mySqlDatetime(new Date());
	console.log("Updated cache file @ " + logdate);
	fs.writeFile("./rsscache.json", json, function(err) {
		if (err) throw err;
		else cb(req, res);
	});
}

// Not sure about this part, is this refreshing the feed?
function refreshFeed(req, res) {
	var newcache = res.locals.newrss;
	returnFeed(req, res, newcache);
}

function errorHandling(err, req, res, next) {
	console.log("Reported error: " + err.stack);
}
