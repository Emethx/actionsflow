<?php

set_include_path(get_include_path() . PATH_SEPARATOR . './google-api-php-client/src');

require_once './google-api-php-client/src/Google/autoload.php'; // or wherever autoload.php is located
require_once './google-api-php-client/src/Google/Service/Blogger.php';

$scriptUri = "https://".$_SERVER["HTTP_HOST"].$_SERVER['PHP_SELF'];

$client = new Google_Client();
$client->setAccessType('online'); // default: offline
$client->setApplicationName('blogger rss'); //name of the application
$client->setClientId('S565470760097-v2mh8n5r1b1cn47j5ugi2u03tpgd7rje.apps.googleusercontent.com'); // ClientID from your API
$client->setClientSecret('grfgrsecret'); //insert your client secret
$client->setRedirectUri($scriptUri);
$client->setDeveloperKey('AIzaSyAxoE_ZDhFGERIZ17R9CNRH5wRKkFDnUz8'); // API key (at bottom of page)
$client->setScopes(array('https://www.googleapis.com/auth/blogger')); //since we are going to use blogger services

$blogger = new Google_Service_Blogger($client);
if (isset($_GET['logout'])) { // logout: destroy token
    unset($_SESSION['token']);
 die('Logged out.');
}

if (isset($_GET['code'])) { // we received the positive auth callback, get the token and store it in session
    $client->authenticate($_GET['code']);
    $_SESSION['token'] = $client->getAccessToken();
}

if (isset($_SESSION['token'])) { // extract token from session and configure client
    $token = $_SESSION['token'];
    $client->setAccessToken($token);
}

if (!$client->getAccessToken()) { // auth call to google
    $authUrl = $client->createAuthUrl();
    header("Location: " . filter_var($authUrl, FILTER_SANITIZE_URL));
    die;
}
$data = $blogger->blogs->getByUrl('https://mangafrr.blogspot.com/');


$load_file=file_get_contents("full.rss");

$read_file=explode("\n",$load_file);

foreach ($read_file as $file_line) {
        if (strpos($file_line, "<title type=\"html\">") !== false) {
                list($junk,$content_title)=explode("<title type=\"html\">",$file_line);
                list($content_title,$junk)=explode("</title>",$content_title);
        };
        if (strpos($file_line, "<published>") !== false) {
                list($junk,$content_date)=explode("<published>",$file_line);
                list($content_date,$junk)=explode("</published>",$content_date);
        };
        if (strpos($file_line, "<content type=\"html\">") !== false) {
                list($junk,$content_desc)=explode("<content type=\"html\">",$file_line);
                @list($content_desc,$junk)=@explode("</content>",$content_desc);
//                echo "Found: $content_title on $content_date\n";

//creates a post object
$mypost = new Google_Service_Blogger_Post();
$mypost->setTitle($content_title);
$mypost->setContent(html_entity_decode($content_desc));
$out_published=date("c",strtotime($content_date));
$mypost->setPublished($out_published);

$data = $blogger->posts->insert('1234567890', $mypost , array('isDraft'=>true)); //post id needs here - put your blogger blog id
echo "<BR><BR><PRE>";
var_dump($data);
echo "</PRE><BR><BR>";
sleep(3);
	};
};
?>
