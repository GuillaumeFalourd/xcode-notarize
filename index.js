// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/


const fs = require('fs');

const core = require('@actions/core');
const execa = require('execa');
const plist = require('plist');


const sleep = (ms) => {
    return new Promise(res => setTimeout(res, ms));
};


const parseConfiguration = () => {
    const configuration = {
        productPath: core.getInput("product-path", {required: true}),
        username: core.getInput("appstore-connect-username", {required: true}),
        password: core.getInput("appstore-connect-password", {required: true}),
        primaryBundleId: core.getInput("primary-bundle-id"),
        verbose: core.getInput("verbose") == "true",
    };

    if (!fs.existsSync(configuration.productPath)) {
        throw Error(`Product path ${configuration.productPath} does not exist.`);
    }

    return configuration
};


const archive = async ({productPath}) => {
    const archivePath = "/tmp/archive.zip"; // TODO Temporary file

    const args = [
        "-c",           // Create an archive at the destination path
        "-k",           // Create a PKZip archive
        "--keepParent", // Embed the parent directory name src in dst_archive.
        productPath,    // Source
        archivePath,    // Destination
    ];

    //console.log("Executing", "ditto", args);

    try {
        await execa("ditto", args);
    } catch (error) {
        core.error(error);
        return null;
    }

    return archivePath;
};


const submit = async ({productPath, archivePath, primaryBundleId, username, password, verbose}) => {
    //
    // Make sure the product exists.
    //

    if (!fs.existsSync(productPath)) {
        throw Error(`No product could be found at ${productPath}`);
    }

    //
    // The notarization process requires us to submit a 'primary
    // bundle id' - this is just a unique identifier for notarizing
    // this specific product. If it is not provided then we simply
    // use the actual bundle identifier from the Info.plist
    //

    if (primaryBundleId === "") {
        const path = productPath + "/Contents/Info.plist";
        if (fs.existsSync(path)) {
            const info = plist.parse(fs.readFileSync(path, "utf8"));
            primaryBundleId = info.CFBundleIdentifier;
        }
    }

    if (primaryBundleId === null) {
        throw Error("No primary-bundle-id set and could not determine bundle identifier from product.");
    }

    //
    // Run altool to notarize this application. This only submits the
    // application to the queue on Apple's server side. It does not
    // actually tell us if the notarization was succesdful or not, for
    // that we need to poll using the request UUID that is returned.
    //

    const args = [
        "altool",
        "--output-format", "json",
        "--notarize-app",
        "-f", archivePath,
        "--primary-bundle-id", primaryBundleId,
        "-u", username,
        "-p", password
    ];

    if (verbose === true) {
        args.push("--verbose");
    }

    //console.log("Executing", "xcrun", args);

    let xcrun = execa("xcrun", args, {reject: false});

    if (verbose == true) {
        xcrun.stdout.pipe(process.stdout);
        xcrun.stderr.pipe(process.stderr);
    }

    const {exitCode, stdout, stderr} = await xcrun;

    if (exitCode === undefined) {
        // TODO Command did not run at all
        throw Error("Unknown failure - altool did not run at all?");
    }

    if (exitCode !== 0) {
        // TODO Maybe print stderr - see where that ends up in the output? console.log("STDERR", stderr);
        const response = JSON.parse(stdout);
        if (verbose === true) {
            console.log(response);
        }

        for (const productError of response["product-errors"]) {
            core.error(`${productError.code} - ${productError.message}`);
        }
        return null;
    }

    const response = JSON.parse(stdout);
    if (verbose === true) {
        console.log(response);
    }

    return response["notarization-upload"]["RequestUUID"];
};


const wait = async ({uuid, username, password, verbose}) => {
    const args = [
        "altool",
        "--output-format", "json",
        "--notarization-info",
        uuid,
        "-u", username,
        "-p", password
    ];

    if (verbose === true) {
        args.push("--verbose");
    }

    //console.log("Executing", "xcrun", args, {reject: false});

    for (let i = 0; i < 12; i++) {
        let xcrun = execa("xcrun", args, {reject: false});

        if (verbose == true) {
            xcrun.stdout.pipe(process.stdout);
            xcrun.stderr.pipe(process.stderr);
        }

        const {exitCode, stdout, stderr} = await xcrun;

        if (exitCode === undefined) {
            // TODO Command did not run at all
            throw Error("Unknown failure - altool did not run at all?");
        }

        if (exitCode !== 0) {
            // TODO Maye print stderr - see where that ends up in the output? console.log("STDERR", stderr);
            const response = JSON.parse(stdout);
            if (verbose === true) {
                console.log(response);
            }

            for (const productError of response["product-errors"]) {
                core.error(`${productError.code} - ${productError.message}`);
            }
            return false;
        }

        const response = JSON.parse(stdout);
        if (verbose === true) {
            console.log(response);
        }

        const notarizationInfo = response["notarization-info"];
        switch (notarizationInfo["Status"]) {
            case "in progress":
                core.info(`Notarization status <in progress>`);
                break;
            case "invalid":
                core.error(`Notarization status <invalid> - ${notarizationInfo["Status Message"]}`);
                return false;
            case "success":
                core.info(`Notarization status <success>`);
                return true;
            default:
                core.error(`Notarization status <${notarizationInfo["Status"]}> - TODO`);
                return false;
        }

        await sleep(10000);
    }

    core.error("Failed to get final notarization status on time.");

    return false;
};

const main = async () => {
    try {
        const configuration = parseConfiguration();

        const archivePath = await core.group('Archiving Application', async () => {
            const archivePath = await archive(configuration)
            if (archivePath !== null) {
                core.info(`Created application archive at ${archivePath}`);
            }
            return archivePath;
        });

        if (archivePath == null) {
            core.setFailed("Notarization failed");
            return;
        }

        const uuid = await core.group('Submitting for Notarizing', async () => {
            let uuid = await submit({archivePath: archivePath, ...configuration});
            if (uuid !== null) {
                core.info(`Submitted package for notarization. Request UUID is ${uuid}`);
            }
            return uuid;
        });

        if (uuid == null) {
            core.setFailed("Notarization failed");
            return;
        }

        const success = await core.group('Waiting for Notarization Status', async () => {
            return await wait({uuid: uuid, archivePath: archivePath, ...configuration})
        });

        if (success == false) {
            core.setFailed("Notarization failed");
            return;
        }

        core.setOutput('product-path', configuration.productPath);
    } catch (error) {
        core.setFailed(`Notarization failed with an unexpected error: ${error.message}`);
    }
};


main();