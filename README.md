# Label Reader - Private Repo for OutFit.AM co.

## Project Structure

The project contains following main components:

1- An Android Mobile app

2- A middleware server app

3- An Analytical Dashboard

## Description of components

A- Android app is the main starting point of the workflow and final point.

B- The middleware play the role of load-balancing and unifying the AI requests to avoid concurrent multi-IP requests that may lead to IP blockage from AI provider. Middleware is not configured against idempotency protection, final data receiving or data integration (all phased to next stage).

C- The Analytical dashboard can live on the same server as middleware, but runs independently. It imports the submitted files from users, cross-checks and removes repeated "Apparel-id", and provides analytical results to single user (no authorization process on dashboard other than loggin-in to see the dashboard).


To see system architecture see: [Label Reader Technical Scope](/docs/Label_Reader_Technical_Scope.md)

To see mobile app architecture see: [Mobile App Architecture](/Mobile_App/architecture.md)

To see the APP-Middleware finalized API-Protocol see: [API Contract](/middle_ware/api_contract.md)

## Project Status

Project is currently under active development. See the progress [daily log to and completion checklist](/dev_log.md).

## Native Android App

This app is customized to match FitOut.AM requirements as follows:

- Scan a barcode to start
- Take up to 6 photos of apparel + labels
- Take photos of the scale display to read net/gross weight
- Cache stored photos if internet connectivity is not available
- Use AI Vision to extract formatted data
- User Review and Connfirm data
- Store to device local storage
- Export daily results using native android sharing
- Retain all database in hidden cache to future reference

### Requirements:

- Mobile Device with Android 8.0 or later
- Back camera - 10 Mega pixel or better + Auto/Manual Flash or Torch
- Mobile or Wifi Internet connectivity
- 2 GB Free Storage on Mobile Device (local or added SD Card)

### Usage:

- Ask your admin for server API address, username and pass (user can start without a connection, but AI vision & results will not work until a valid server connection)
- Download and Install .apk application on your mobile device.
- (First use only) Tap on Setting page (button-right of the app screen) > Input server address, username and password > save settings
- Tap on camera icon (Bottom left) > Start a new record by scanning item barcode (Apparel ID) > Take pictures > Finish
- Items will be Automatically sent to server for AI Vision >> Items will wait until internet connection is available.
- Successful items will return for your review. Tap on Review results to check and confirm. Confirmed results will be stored for reporting.
- To send daily reports, tap on "export and send" to share result files using Android sharing.

