var path = require('path');
var fs = require('fs');
var ip4ToInt = require('./ip2int').ip4ToInt;
var intToIP4 = require('./ip2int').intToIP4;

var pacTemplate = fs.readFileSync(path.dirname(module.filename) + "/" +
        "flora.pac.template.js", {encoding : "utf8"});

// jshint -W103:false
var baseConfig = require("./pac-config");

if (process.mainModule === module) {
    main();
}

module.exports = floraPac;

floraPac.main = main;

function main() {
    // a simple test for command-line-arguments-existent that make 'optimist' not really required
    var argv = (process.argv.length > 2) ? require('yargs')["argv"] : null;
    if (argv && (argv.help || argv.h)) {
        console.info(""
                + "usage: flora-pac [-h] [-f PAC] [-p PROXY] [-c CONFIG]\n"
                + "\n"
                + "Valid options:\n"
                + "  -h [--help]                : show this help message and exit\n"
                + '  -c [--config] ARG          : path to json/ini format config file\n'
                + '                               defaults to "pac-config.json" in current dir\n'
                + '  -f [--file] ARG            : overrides the "file" option of config file\n'
                + '                               path to output pac\n'
                + '  -x [--proxy] ARG           : overrides the "proxy" option of config file\n'
                + '                               the proxy parameter in the pac file, for example,\n'
                + '                               "SOCKS5 127.0.0.1:7070; SOCKS 127.0.0.1:7070"\n'
                + '  -i [--internal-proxy] ARG  : overrides the "internalProxy" option of config file\n'
                + '                               internal proxy server, defaults to "DIRECT", it\'s useful\n'
                + '                               if you need an internal proxy to access outside network\n'
                + "");
        return;
    }
    floraPac(null, argv);
}


function readOptions(target, options, key/*, aliasKey1, aliasKey2, ...*/) {
    if (options) {
        for (var i = 2; i < arguments.length; i++) {
            var value = options[arguments[i]];
            if (value != null) {
                if (target) {
                    target[key] = value;
                }
                return value;
            }
        }
    }
}


function readConfig(configFile) {
    if (configFile || ["pac-config.json", "pac-config.ini"].some(function (f) {
        if (fs.existsSync(f)) {
            configFile = f;
            return true;
        }
    })) {
        console.log("Using config file: " + configFile);
        var content = fs.readFileSync(configFile, "utf8");
        if (configFile.match(/\.ini$/)) {
            var iniConf = require("ini").parse(content) || {};
            var result = iniConf["pac-config"] || {};
            for (var section in iniConf) {
                if (iniConf.hasOwnProperty(section) && (section != "pac-config")) {
                    if (section.match((/(Domains|Ips)$/))) {
                        result[section] = Object.keys(iniConf[section]);
                    } else {
                        result[section] = iniConf[section];
                    }
                }
            }
            return result;
        }
        return JSON.parse(content || "{}");
    }
}


function floraPac(userConfig, options) {
    // do a copy
    var config = JSON.parse(JSON.stringify(baseConfig));

    if (userConfig == null) {
        userConfig = readConfig(readOptions(null, options, "config", "c")) || {};
    }

    readOptions(userConfig, options, "file", "f");
    readOptions(userConfig, options, "proxy", "x");
    readOptions(userConfig, options, "internalProxy", "internal-proxy", "i");

    for (var key in userConfig) {
        if (userConfig.hasOwnProperty(key)) {
            if (Array.isArray(config[key])) {
                Array.prototype.push.apply(config[key], userConfig[key]);
            } else {
                config[key] = userConfig[key];
            }
        }
    }

    config["ips"] = config["ips"] || [];
    fetchChnIpList(function (ip, count, date) {
        var data = [ip4ToInt(ip), parseInt(count)];
        config["ips"].push(data);
        if (config.debug) {
            console.log("Found chn ip: %s - %s at %s", ip, intToIP4(data[1]), date);
        }
    }, function (ok) {
        if (ok) {
            var pacData = generatePac(config, options || {});
            fs.writeFileSync(config.file, pacData, {encoding : 'utf8'});
            console.log("File generated:", config.file);
            if (config.callback) {
                config.callback();
            }
        }
    });
}


function generatePac(config, options) {
    // 1: LOCAL (INTRANET), 2: NORMAL (CHINA-NET), 3: GFWed (INTERNET), 4: poisoned
    for (var key in config) {
        if (!config.hasOwnProperty(key)) {
            // noinspection UnnecessaryContinueJS
            continue;

        } else if (key == "localIps") {
            readIpList(key, 1);
        } else if (key == "normalIps") {
            readIpList(key, 2);
        } else if (key == "fakeIps") {
            readIpList(key, 4);

        } else if (key == "localDomains") {
            readDomainList(key, 1);
        } else if (key == "normalDomains") {
            readDomainList(key, 2);
        } else if (key == "walledDomains") {
            readDomainList(key, 3);
        }
    }

    function readIpList(key, action) {
        config["ips"] = config["ips"] || [];
        config[key].forEach(function (item) {
            if (typeof item == 'string') {
                var value = ip4ToInt(item);
                if (value != null) {
                    config["ips"].push([value, 1, action]);
                    return;
                }
            } else if (item.length == 2) {
                var start = ip4ToInt(item[0]);
                var end = ip4ToInt(item[1]);
                var count = (start < end) ? (end - start) : item[1];
                if ((start > 0) && (count > 0)) {
                    config["ips"].push((action == 2) ? [start, count] : [start, count, action]);
                    return;
                }
            }
            console.log("Found invalid ip of '" + key + "':", item);
        });
    }

    function readDomainList(key, action) {
        config["domains"] = config["domains"] || {};
        config[key].forEach(function (domain) {
            config["domains"][domain] = action;
        });
    }

    config["ips"] = sortIpList(config["ips"]);
    config["ips"].forEach(function (item2, i, ips) {
        if (i > 0) {
            var item1 = ips[i - 1];
            var value1 = item1[2] || 2;
            var value2 = item2[2] || 2;
            if ((item2[0] < item1[0] + item1[1])) {
                console.error("Collapsed ip: [%s - %s] : %d, [%s - %s] : %d",
                        intToIP4(item1[0]), intToIP4(item1[0] + item1[1] - 1), value1,
                        intToIP4(item2[0]), intToIP4(item2[0] + item2[1] - 1), value2);
            }
            if ((item2[0] == item1[0] + item1[1]) && (value1 == value2)) {
                console.warn("ip can be merge: [%s - %s] : %d, [%s - %s] : %d",
                        intToIP4(item1[0]), intToIP4(item1[0] + item1[1] - 1), value1,
                        intToIP4(item2[0]), intToIP4(item2[0] + item2[1] - 1), value2);
            }
        }
        if (options["dump-ip"]) {
            console.info("[%s - %s] : %d / count=%d",
                    intToIP4(item2[0]), intToIP4(item2[0] + item2[1] - 1), item2[2] || 2, item2[1]);
        }
    });

    config["proxies"] = [
        null,                                                                               // 0: UNKNOWN
        'DIRECT',                                                                           // 1: LOCAL  (INTRANET)
        (config['internalProxy'] ? (config['internalProxy'] + '; ' + 'DIRECT') : 'DIRECT'), // 2: NORMAL (CHINA-NET)
        (config['proxy'] + '; ' + 'DIRECT'),                                                // 3: GFWed  (INTERNET)
        (config['proxy'])                                                                   // 4: poisoned
    ];

    var result = pacTemplate;
    for (key in config) {
        if (config.hasOwnProperty(key)) {
            result = result.replace("{/*{" + key + "}*/}", JSON.stringify(config[key]));
            result = result.replace("[/*[" + key + "]*/]", JSON.stringify(config[key]));
            result = result.replace("'{{" + key + "}}'", JSON.stringify(config[key]));
        }
    }
    return result;
}


function sortIpList(ips) {
    // item: [startIp (int), count (int), value (int)]
    while (true) {
        ips.sort(function (r1, r2) {return r1[0] - r2[0]});
        var changed = false;
        var result = [];
        // detect collapsed and break into more ranges
        for (var i = 0; i < ips.length; i++) {
            var item1 = ips[i];
            var item2 = ips[i + 1];
            if (item2 && (item2[0] < item1[0] + item1[1])) {
                if (item1[0] == item2[0] && item1[1] < item2[1]) {
                    var temp = item1;
                    item1 = item2;
                    item2 = temp;
                }
                // item1[0] <= item2[0] <= item2[0] + item2[1] <= item1[0] + item1[1]
                var r1 = [item1[0], item2[0] - item1[0]];
                var r2 = item2;
                var r3 = [item2[0] + item2[1], item1[0] + item1[1] - item2[0] - item2[1]];
                if (r1[1] >= 0 && r3[1] >= 0) {
                    if (item1[2] != 2) {
                        r1[2] = r3[2] = item1[2];
                    }
                    if (r1[1] > 0) {
                        result.push(r1);
                    }
                    result.push(r2);
                    if (r3[1] > 0) {
                        result.push(r3);
                    }
                    ++i;
                    changed = true;
                    continue;
                }
            }
            result.push(ips[i]);
        }

        if (changed) {
            ips = result;
        } else {
            return mergeNeighbors(ips);
        }
    }

    function mergeNeighbors(ips) {
        var result = [];
        for (var i = 0; i < ips.length; i++) {
            var item1 = ips[i];
            var item2 = ips[i + 1];
            var value = item1[2] || 2;
            while (item2 && (value == (item2[2] || 2)) && (item2[0] <= item1[0] + item1[1])) {
                item1[1] = Math.max(item1[1], item2[0] + item2[1] - item1[0]);
                ++i;
                item2 = ips[i + 1];
            }
            result.push(item1);
        }
        return result;
    }
}

function fetchChnIpList(lineCallback, eofCallback) {
    var url = 'http://ftp.apnic.net/apnic/stats/apnic/delegated-apnic-latest';
    var file = 'delegated-apnic-latest';

    if (fs.existsSync(file)) {
        fs.readFile(file, {encoding : 'utf8'}, function (err, data) {
            if (err) {
                console.info("Read File " + file + " failed:", err);
            } else {
                getChunk(data);
                getChunk('\n');
                eofCallback(true);
            }
        });
    } else {
        // fetch data from apnic
        console.info("Fetching data from apnic.net, it might take a few minutes, please wait...");
        var http = require('http');
        http.get(url, function (res) {
            if (res.statusCode == 200) {
                res.setEncoding('utf8');
                res.on('data', getChunk);
                res.on('end', function () {
                    getChunk('\n');
                    eofCallback(true);
                });
                res.on('error', function (e) {
                    console.info("Fetching data from apnic.net failed:", e);
                    eofCallback(false);
                });
            } else {
                console.info("Fetching data from apnic.net failed:", res.statusCode);
                eofCallback(false);
            }
        });
    }

    // apnic|CN|ipv4|111.119.64.0|16384|20090703|allocated
    var pattern = /^apnic\|cn\|ipv4\|([0-9\.]+)\|([0-9]+)\|([0-9]+)\|a.*$/gmi;

    var lastChunk = "";

    function getChunk(chunk) {
        chunk = (lastChunk + chunk);
        var lastLF = chunk.lastIndexOf('\n');
        if (lastLF == -1) {
            lastChunk = chunk;
        } else {
            lastChunk = chunk.substring(lastLF + 1);
            chunk = chunk.substring(0, lastLF);
            for (var arr; (arr = pattern.exec(chunk)) !== null;) {
                lineCallback(arr[1], arr[2], arr[3]);
            }
        }
    }
}

